import type { Database } from './port.js'

/**
 * Numbered, forward-only, run inside a transaction at startup.
 *
 * Adding a migration means appending to this array. Never edit a shipped one —
 * a database that already applied version N will not re-run it.
 */
export interface Migration {
  readonly version: number
  readonly name: string
  readonly up: string
}

/**
 * The second migration this database has ever had, and the first to run against
 * one holding real data.
 *
 * Three nullable columns and nothing else. Nullable is the whole design: every
 * `conversation.created` ever appended lacks these fields, and a rebuild has to
 * produce the same rows it always did for them. `kind IS NULL` therefore means
 * "an ordinary conversation", which is what every existing row is.
 *
 * No index. Asides are read by `parent_id`, but a user has tens of
 * conversations and a handful of asides each; an index here would be ceremony,
 * and `PRAGMA user_version` moving is the risk worth minimising.
 */
const ASIDE_COLUMNS = `
  ALTER TABLE conversations ADD COLUMN kind            TEXT;
  ALTER TABLE conversations ADD COLUMN parent_id       TEXT;
  ALTER TABLE conversations ADD COLUMN source_event_id TEXT;
`

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial',
    up: `
      -- The append-only log. Everything else in this file is a projection that
      -- can be dropped and rebuilt from these rows.
      CREATE TABLE events (
        seq             INTEGER PRIMARY KEY AUTOINCREMENT,
        id              TEXT    NOT NULL UNIQUE,
        conversation_id TEXT    NOT NULL,
        actor           TEXT    NOT NULL,
        type            TEXT    NOT NULL,
        payload         TEXT    NOT NULL,
        created_at      INTEGER NOT NULL,
        schema_ver      INTEGER NOT NULL
      );
      CREATE INDEX events_conv_seq ON events (conversation_id, seq);
      CREATE INDEX events_type ON events (type);

      CREATE TABLE projects (
        id                    TEXT PRIMARY KEY,
        root_path             TEXT NOT NULL,
        name                  TEXT NOT NULL,
        permission_profile_id TEXT,
        created_at            INTEGER NOT NULL
      );

      CREATE TABLE conversations (
        id         TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title      TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      -- One row per message. Agent messages are built up from delta events, so
      -- content grows and status moves streaming -> complete.
      CREATE TABLE messages (
        id              TEXT PRIMARY KEY,
        conversation_id TEXT    NOT NULL,
        seq             INTEGER NOT NULL,
        actor           TEXT    NOT NULL,
        -- Always set. For agent messages it is the provider's streaming item id,
        -- which is how a run of deltas is stitched into one row; for user
        -- messages it is the originating event id, so the index stays simple.
        item_ref        TEXT    NOT NULL,
        content         TEXT    NOT NULL DEFAULT '',
        status          TEXT    NOT NULL,
        created_at      INTEGER NOT NULL
      );
      CREATE INDEX messages_conv_seq ON messages (conversation_id, seq);
      CREATE UNIQUE INDEX messages_item_ref ON messages (conversation_id, item_ref);

      CREATE TABLE agent_sessions (
        id              TEXT PRIMARY KEY,
        conversation_id TEXT    NOT NULL,
        agent_id        TEXT    NOT NULL,
        session_ref     TEXT    NOT NULL,
        cwd             TEXT    NOT NULL,
        model           TEXT,
        cli_version     TEXT,
        status          TEXT    NOT NULL,
        started_at      INTEGER NOT NULL
      );
      CREATE INDEX agent_sessions_conv ON agent_sessions (conversation_id);

      CREATE TABLE approvals (
        id              TEXT PRIMARY KEY,
        conversation_id TEXT    NOT NULL,
        agent_id        TEXT,
        kind            TEXT    NOT NULL,
        request         TEXT    NOT NULL,
        outcome         TEXT,
        scope           TEXT,
        decided_by      TEXT,
        decided_at      INTEGER,
        policy_rule_id  TEXT,
        expires_at      INTEGER NOT NULL,
        created_at      INTEGER NOT NULL
      );
      CREATE INDEX approvals_conv ON approvals (conversation_id);

      CREATE TABLE handoffs (
        id               TEXT PRIMARY KEY,
        conversation_id  TEXT    NOT NULL,
        from_agent       TEXT    NOT NULL,
        to_agent         TEXT    NOT NULL,
        brief            TEXT    NOT NULL,
        source_event_ids TEXT    NOT NULL,
        created_at       INTEGER NOT NULL
      );

      -- Lets us detect a projection that has drifted from the log, and is the
      -- resume point for an incremental rebuild.
      CREATE TABLE projection_state (
        name     TEXT PRIMARY KEY,
        last_seq INTEGER NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: 'aside-conversations',
    up: ASIDE_COLUMNS,
  },
  {
    version: 3,
    name: 'pending-questions',
    /*
     * The one piece of transcript state a paged read cannot get from anywhere
     * else.
     *
     * A page is a suffix of the log, so anything derived by *accumulation*
     * cannot be rebuilt from it — an agent can ask a question thousands of
     * events before the page the reader opens on. Approvals already had this
     * problem and already had a table; questions had neither, and folding the
     * whole conversation to find them is the cost this phase exists to remove.
     *
     * Shaped like `approvals` deliberately: requested, then answered or expired,
     * with the answer's absence being what "pending" means. `answered_at IS
     * NULL` is the query.
     */
    up: `
      CREATE TABLE questions (
        id              TEXT PRIMARY KEY,
        conversation_id TEXT    NOT NULL,
        agent_id        TEXT,
        event_id        TEXT    NOT NULL,
        request         TEXT    NOT NULL,
        answered_at     INTEGER,
        expires_at      INTEGER NOT NULL,
        created_at      INTEGER NOT NULL
      );
      CREATE INDEX questions_conv ON questions (conversation_id);

      /*
       * Backfilled from the log, and the table is wrong without this.
       *
       * A new projection starts empty, and nothing rebuilds projections on
       * startup -- EventStore.open runs migrate() and returns. So an upgraded
       * database would have had a questions table containing nothing, and since
       * the paged transcript reads pending questions from HERE rather than by
       * folding the log, every question an agent was already waiting on would
       * have disappeared: no card, no error, and a fresh test database passing
       * every test. Found in review, not by running it.
       *
       * Done in SQL inside the migration's own transaction rather than by
       * calling rebuildProjections() afterwards. Rebuilding replays every event
       * into every projection -- 247,800 of them on the author's database -- to
       * populate one table, and it would run outside the transaction that
       * created it, so a failure would leave the schema migrated and the table
       * empty.
       *
       * The events_type index makes both scans indexed. COALESCE on request
       * because the column is NOT NULL and json_extract yields NULL for a
       * payload that recorded no request; 'null' is what the live projection
       * writes for the same case.
       *
       * NB: no backticks anywhere in this comment. It lives inside a template
       * literal, and one would end the string -- which is the trap CLAUDE.md
       * records for exactly this file, and it still caught me.
       */
      INSERT INTO questions
        (id, conversation_id, agent_id, event_id, request, answered_at, expires_at, created_at)
      SELECT
        json_extract(q.payload, '$.userInputId'),
        q.conversation_id,
        q.actor,
        q.id,
        COALESCE(json_extract(q.payload, '$.request'), 'null'),
        (SELECT MAX(a.created_at) FROM events a
          WHERE a.type = 'userinput.answered'
            AND json_extract(a.payload, '$.userInputId')
                = json_extract(q.payload, '$.userInputId')),
        COALESCE(json_extract(q.payload, '$.expiresAt'), 0),
        q.created_at
      FROM events q
      WHERE q.type = 'userinput.requested'
        AND json_extract(q.payload, '$.userInputId') IS NOT NULL
      ON CONFLICT (id) DO NOTHING;

      /*
       * The high-water mark for the projection this migration just created.
       *
       * projectionDrift() compares every name in PROJECTION_NAMES against the
       * log's last seq and reports the ones behind. A backfilled table with no
       * projection_state row reads as sequence 0 -- so the drift check would
       * have reported questions as 249,099 events behind on a database where it
       * was in fact completely up to date, until the next append happened to
       * bump every projection at once and the symptom vanished on its own.
       *
       * COALESCE because MAX over an empty events table is NULL, and a fresh
       * database installs this migration with nothing in it.
       *
       * The backfill above reads the whole log, so the whole log is exactly what
       * this projection has seen.
       */
      INSERT INTO projection_state (name, last_seq)
      SELECT 'questions', COALESCE((SELECT MAX(seq) FROM events), 0)
      ON CONFLICT (name) DO UPDATE SET last_seq = excluded.last_seq;
    `,
  },
  {
    version: 4,
    name: 'project-as-domain',
    /*
     * Phase 2's Project, and the table is **recreated rather than altered**.
     *
     * `projects` has existed since migration 1 and has never been written: there
     * is no INSERT, UPDATE or SELECT against it anywhere in this repository, and
     * it is not in PROJECTION_NAMES, so nothing rebuilds it either. It was a
     * placeholder for the domain this migration finally supplies.
     *
     * That is what makes DROP the honest option rather than the destructive one.
     * `canonical_root` cannot be derived in SQL — resolving a path means asking
     * the filesystem, and copying `root_path` into it would record a value that
     * nobody resolved and that every uniqueness check downstream would then
     * trust. ALTER TABLE also cannot add a NOT NULL column to an existing table
     * without a default, so altering would leave the two columns the domain most
     * depends on permanently nullable to preserve rows that do not exist.
     *
     * If a row somehow did exist, `migrate()` snapshots the database before any
     * upgrade from a non-zero version, so this is recoverable rather than final.
     *
     * `permission_profile_id` is carried across although the Phase 2 domain does
     * not name it. Nothing reads it, it costs one nullable column, and dropping a
     * field this change was not asked to remove is the more expensive mistake.
     */
    up: `
      DROP TABLE projects;

      CREATE TABLE projects (
        id                    TEXT    PRIMARY KEY,
        name                  TEXT    NOT NULL,
        root                  TEXT    NOT NULL,
        -- The filesystem's own answer for 'root', symlinks resolved. Supplied by
        -- the caller because only main can ask; this package never touches disk.
        canonical_root        TEXT    NOT NULL,
        -- What uniqueness is actually enforced on: canonical_root folded for a
        -- case-insensitive filesystem, or identical to it on a case-sensitive
        -- one. Stored rather than computed in the index because the fold is a
        -- property of the volume the project lives on, which SQL cannot know.
        canonical_key         TEXT    NOT NULL,
        workspace_file        TEXT,
        permission_profile_id TEXT,
        created_at            INTEGER NOT NULL,
        last_opened_at        INTEGER NOT NULL
      );

      -- The invariant the domain rests on: one project per real directory. A
      -- second Add Project on the same folder must find the first, not shadow it.
      CREATE UNIQUE INDEX projects_canonical_key ON projects (canonical_key);
      -- The rail's order, and the only ordering anything asks for.
      CREATE INDEX projects_last_opened ON projects (last_opened_at DESC);
    `,
  },
  {
    version: 5,
    name: 'project-owns-its-settings',
    /*
     * The permission profile and the cast move up to the Project.
     *
     * They were per-conversation, which put the same three questions in front of
     * a person once per conversation and let two conversations in one directory
     * disagree about what may be run there. A profile is an answer about a
     * *place* — "agents may write in this repository" — and it was only ever
     * conversation-scoped because the conversation was the top-level thing.
     *
     * `permission_profile_id` already exists: migration 4 carried it across
     * without a reader, on the argument that dropping a field it was not asked
     * to remove was the more expensive mistake. This is the migration that
     * proves that call, and it needs no DDL for that column at all.
     *
     * `agent_ids` is a JSON array and **nullable on purpose**. Null is not an
     * empty cast; it is "this project has never been asked", which is what every
     * row migrated from before this change is. The distinction matters because
     * an empty array is a legitimate answer — a project with no agents in it —
     * and collapsing the two would silently re-add the default cast to a project
     * somebody had deliberately emptied.
     *
     * ALTER rather than a recreate, unlike migration 4: this table now holds
     * real rows that nothing can reconstruct, and the column is nullable, which
     * is the one shape ALTER TABLE ADD COLUMN accepts without a default.
     */
    up: `
      ALTER TABLE projects ADD COLUMN agent_ids TEXT;
    `,
  },
  {
    version: 6,
    name: 'projects-keep-an-arrangement',
    /*
     * The rail's order becomes something the person owns.
     *
     * It was `last_opened_at DESC` — computed, never stored, and `QuickRail.tsx`
     * said in a comment that a move "would have nowhere to write". This is the
     * column that comment named. Recency no longer decides the rail: opening a
     * project stops moving its tile, which is the whole point of being able to
     * arrange them.
     *
     * **Backfilled in the order the person is looking at right now.** An added
     * column defaulting to null would put every existing project in one
     * undifferentiated bucket and let SQLite pick, so the first launch after the
     * upgrade would shuffle a rail somebody already knows. Counting how many rows
     * sort above each row reproduces exactly today's `last_opened_at DESC,
     * created_at DESC` as 0..n-1, so the upgrade is invisible until the first
     * drag — which is the only acceptable outcome for a list people navigate by
     * muscle memory.
     *
     * Nullable rather than `NOT NULL DEFAULT 0`: ALTER TABLE ADD COLUMN takes a
     * nullable column without rewriting the table, and `create` assigns
     * `MAX(sort_order) + 1` from here on, so null is unreachable for new rows.
     * `list` still orders on the old columns after it, which is what keeps a null
     * — from a hand-edited database — deterministic instead of arbitrary.
     *
     * `last_opened_at` is kept and still written by `touch`. It stopped being the
     * rail's sort key; it did not stop being true, and nothing else that reads it
     * was asked to change.
     */
    up: `
      ALTER TABLE projects ADD COLUMN sort_order INTEGER;
      UPDATE projects SET sort_order = (
        SELECT COUNT(*) FROM projects AS ahead
         WHERE ahead.last_opened_at > projects.last_opened_at
            OR (ahead.last_opened_at = projects.last_opened_at
                AND ahead.created_at > projects.created_at)
      );
    `,
  },
  {
    version: 7,
    name: 'projects-keep-a-note',
    /*
     * A scratchpad per project: what to check later, what is still pending.
     *
     * **In the registry rather than the log, and the distinction is the one
     * `projects.ts` opens with.** The log holds what happened, and its value is
     * that it happened. A note is not that — it is a current fact that gets
     * corrected, edited over and eventually deleted, and appending an event per
     * revision would file a person crossing out a reminder as history. It is the
     * same argument that keeps a project's name here.
     *
     * It is also not `context.usage`. That rule — state that would be worse to
     * read back later than to lack — sends a value to a push channel and nowhere
     * else. A note fails it in the other direction: read back a week later it is
     * exactly as useful as when it was written, which is the whole point of
     * writing it down.
     *
     * Nullable, so ALTER adds it without rewriting the table, and so "never
     * written" is distinct from "emptied". Nothing reads that distinction today;
     * it costs nothing and collapsing it later is easier than inventing it.
     */
    up: `
      ALTER TABLE projects ADD COLUMN notes TEXT;
    `,
  },
  {
    version: 8,
    name: 'app-keeps-a-note',
    /*
     * The same scratchpad one level up: a note that belongs to no project.
     *
     * **A table rather than a column, because there is no row to add one to.**
     * Version 7 put the project note on the project, which is where a fact about
     * a project belongs. This note is a fact about the app, and the app is not a
     * row anywhere — so the choice was a single-row table or a general key/value
     * bag, and a bag would invite everything that is currently a considered
     * column to become an untyped string.
     *
     * The CHECK is what keeps it single-row. Without it a second insert would
     * succeed and every read would silently pick one of two notes.
     *
     * `width` is the panel's width as a fraction of the window, not pixels. It
     * is stored beside the note because it is answered the same way and read at
     * the same moment. A fraction rather than a count of pixels so that moving
     * to a smaller display reopens a panel that still fits, instead of one wider
     * than the window that has to be clamped back on read.
     */
    up: `
      CREATE TABLE app_note (
        id    INTEGER PRIMARY KEY CHECK (id = 1),
        notes TEXT,
        width REAL
      );
    `,
  },
  {
    version: 9,
    name: 'a-note-is-a-size-too',
    /*
     * How big each note was left, for both of them.
     *
     * Version 8 stored a width for the app's note because its panel was already
     * draggable on one edge. Both notes now drag on two, so the pair travels
     * together — and a project's belongs on the project for the same reason its
     * text does: it is a current fact about that project, corrected in place and
     * gone when the project is.
     *
     * Fractions of the window, never pixels, and the reasoning is `NOTE_SIZE`'s:
     * a count of pixels reopens a note wider than the display it moved to.
     *
     * All three nullable, which ALTER TABLE ADD COLUMN requires anyway without a
     * default — and null is the value that means something here. It reads as
     * "never dragged", which is what lets the stylesheet's own ceiling stay in
     * charge until somebody says otherwise. A zero could not say that.
     */
    up: `
      ALTER TABLE app_note ADD COLUMN height REAL;
      ALTER TABLE projects ADD COLUMN note_width REAL;
      ALTER TABLE projects ADD COLUMN note_height REAL;
    `,
  },
  {
    version: 10,
    name: 'the-notes-you-keep',
    /*
     * A collection of notes that belong to nothing in particular.
     *
     * **Rows rather than a second single-row table**, which is the whole of what
     * this adds. Version 8 gave the app one note because there was one to give,
     * and the CHECK that keeps it single-row is exactly what this case cannot
     * live with: several documents, each addressed, updated and deleted on its
     * own.
     *
     * **No title column.** A row is labelled by the note's own first line, so a
     * title would be a second copy of something already in the document and a
     * second thing to keep in step with it.
     *
     * **No size, unlike `app_note`.** That panel is dragged on two edges and has
     * to reopen where it was left; this one is a fixed panel beside a menu, and
     * a column for a size nothing can change would be a column that only ever
     * holds its default.
     *
     * Both stamps, because what orders the list is still open — made, or last
     * touched — and neither is recoverable from the other after the fact.
     */
    up: `
      CREATE TABLE kept_note (
        id         TEXT PRIMARY KEY,
        notes      TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `,
  },
  {
    version: 11,
    name: 'notes-in-the-order-you-put-them',
    /*
     * Where each kept note sits, because the order stopped being computed.
     *
     * Version 10 left the list ordered by `updated_at`, which is a guess about
     * what somebody wants to see next. Dragging a row says it outright, and a
     * said order has to be written down.
     *
     * **Backfilled by the rank the list is already drawn in**, so the first
     * launch after this migration shows exactly what the last one showed. A
     * `DEFAULT 0` would have been one line and would have reordered every
     * existing note once, silently — the kind of change nobody connects to an
     * upgrade, and the kind that loses an arrangement somebody was relying on.
     *
     * The tie-break repeats `list()`'s: equal stamps, lower id first. It has to,
     * or the two orders disagree for exactly the rows a millisecond apart.
     *
     * Nullable rather than `NOT NULL DEFAULT`, because null never survives the
     * UPDATE below and because a NOT NULL add is the form SQLite is fussiest
     * about across versions.
     */
    up: `
      ALTER TABLE kept_note ADD COLUMN position INTEGER;
      UPDATE kept_note
         SET position = (
           SELECT COUNT(*) FROM kept_note AS earlier
            WHERE earlier.updated_at > kept_note.updated_at
               OR (earlier.updated_at = kept_note.updated_at AND earlier.id < kept_note.id)
         );
    `,
  },
  {
    version: 12,
    name: 'a-project-knows-its-host',
    up: `
      ALTER TABLE projects ADD COLUMN host TEXT NOT NULL DEFAULT '';

      DROP INDEX projects_canonical_key;
      CREATE UNIQUE INDEX projects_canonical_key ON projects (host, canonical_key);
    `,
  },
  {
    version: 13,
    name: 'where-a-remote-projects-agents-run',
    up: `
      ALTER TABLE projects ADD COLUMN agent_cwd TEXT;
    `,
  },
  {
    version: 14,
    name: 'where-a-projects-traffic-listens',
    up: `
      ALTER TABLE projects ADD COLUMN traffic_origin TEXT;
      ALTER TABLE projects ADD COLUMN traffic_port INTEGER
        CHECK (traffic_port IS NULL OR traffic_port BETWEEN 1 AND 65535);
      ALTER TABLE projects ADD COLUMN traffic_access TEXT NOT NULL DEFAULT 'loopback'
        CHECK (traffic_access IN ('loopback', 'lan'));

      CREATE UNIQUE INDEX projects_traffic_port ON projects (traffic_port)
        WHERE traffic_port IS NOT NULL;

      CREATE TABLE traffic_legacy_import (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
        assigned_project_id TEXT
      );
      INSERT INTO traffic_legacy_import (id, completed) VALUES (1, 0);
    `,
  },
  {
    version: 15,
    name: 'what-a-legacy-traffic-connection-was',
    up: `
      ALTER TABLE traffic_legacy_import ADD COLUMN pending_origin TEXT;
      ALTER TABLE traffic_legacy_import ADD COLUMN pending_port INTEGER
        CHECK (pending_port IS NULL OR pending_port BETWEEN 1 AND 65535);
      ALTER TABLE traffic_legacy_import ADD COLUMN pending_access TEXT
        CHECK (pending_access IS NULL OR pending_access IN ('loopback', 'lan'));
    `,
  },
  {
    version: 16,
    name: 'a-legacy-connection-whose-port-could-not-be-read',
    up: `
      CREATE TABLE traffic_legacy_import_next (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
        assigned_project_id TEXT,
        pending_recorded INTEGER NOT NULL DEFAULT 0 CHECK (pending_recorded IN (0, 1)),
        pending_origin TEXT,
        pending_port INTEGER
          CHECK (pending_port IS NULL OR pending_port BETWEEN 0 AND 65535),
        pending_access TEXT
          CHECK (pending_access IS NULL OR pending_access IN ('loopback', 'lan')),
        pending_error TEXT
      );

      INSERT INTO traffic_legacy_import_next
        (id, completed, assigned_project_id, pending_recorded, pending_origin, pending_port,
         pending_access)
        SELECT id, completed, assigned_project_id,
               CASE WHEN pending_origin IS NULL AND pending_port IS NULL THEN 0 ELSE 1 END,
               pending_origin, pending_port, pending_access
          FROM traffic_legacy_import;

      DROP TABLE traffic_legacy_import;
      ALTER TABLE traffic_legacy_import_next RENAME TO traffic_legacy_import;
    `,
  },
  {
    version: 17,
    name: 'the-variable-an-application-reads-its-endpoint-from',
    up: `
      ALTER TABLE projects ADD COLUMN traffic_env_var TEXT;
    `,
  },
  {
    version: 18,
    name: 'a-listener-reachable-from-the-network-by-default',
    up: `
      /*
       * Rewriting every stored row is legitimate here, and the reason is
       * narrower than "the default changed".
       *
       * The traffic panel has never had a control for this setting — the
       * column, the schema, the IPC and main's handling all shipped, and the
       * one thing that could express a preference did not. So a stored
       * 'loopback' cannot be somebody's answer, because there was nowhere to
       * give one. The column writes it in exactly two places, and both are
       * "what a thing gets before anyone has asked": the DEFAULT below, and
       * the literal at the insert in projects.ts. The third writer is the
       * legacy import, which carries the constant 'lan' — which is why every
       * project that predates the column reads 'lan' already, and is a fair
       * sign this was always the intent.
       *
       * A per-row UPDATE ... WHERE traffic_access = 'loopback' would say the
       * same thing for the two values this column can hold; the copy states
       * 'lan' outright so a value the CHECK would have rejected cannot ride
       * through on a row nobody thought about.
       *
       * **SQLite cannot alter a column's DEFAULT**, so the only way to change
       * it is to rebuild the table — which is what the rest of this is. There
       * are no foreign keys, views or triggers anywhere in this schema, so the
       * rename rewrites nothing and the whole thing is one transaction with
       * the rest of the migration run.
       */
      CREATE TABLE projects_rebuilt (
        id                    TEXT    PRIMARY KEY,
        name                  TEXT    NOT NULL,
        root                  TEXT    NOT NULL,
        canonical_root        TEXT    NOT NULL,
        canonical_key         TEXT    NOT NULL,
        workspace_file        TEXT,
        permission_profile_id TEXT,
        created_at            INTEGER NOT NULL,
        last_opened_at        INTEGER NOT NULL,
        agent_ids             TEXT,
        sort_order            INTEGER,
        notes                 TEXT,
        note_width            REAL,
        note_height           REAL,
        host                  TEXT    NOT NULL DEFAULT '',
        agent_cwd             TEXT,
        traffic_origin        TEXT,
        traffic_port          INTEGER
          CHECK (traffic_port IS NULL OR traffic_port BETWEEN 1 AND 65535),
        traffic_access        TEXT    NOT NULL DEFAULT 'lan'
          CHECK (traffic_access IN ('loopback', 'lan')),
        traffic_env_var       TEXT
      );

      INSERT INTO projects_rebuilt (
        id, name, root, canonical_root, canonical_key, workspace_file,
        permission_profile_id, created_at, last_opened_at, agent_ids, sort_order,
        notes, note_width, note_height, host, agent_cwd, traffic_origin,
        traffic_port, traffic_access, traffic_env_var
      )
      SELECT
        id, name, root, canonical_root, canonical_key, workspace_file,
        permission_profile_id, created_at, last_opened_at, agent_ids, sort_order,
        notes, note_width, note_height, host, agent_cwd, traffic_origin,
        traffic_port, 'lan', traffic_env_var
      FROM projects;

      DROP TABLE projects;
      ALTER TABLE projects_rebuilt RENAME TO projects;

      CREATE INDEX projects_last_opened ON projects (last_opened_at DESC);
      CREATE UNIQUE INDEX projects_canonical_key ON projects (host, canonical_key);
      CREATE UNIQUE INDEX projects_traffic_port ON projects (traffic_port)
        WHERE traffic_port IS NOT NULL;
    `,
  },
  {
    version: 19,
    name: 'the-name-a-conversation-goes-by',
    up: `
      UPDATE conversations
         SET title = latest.title
        FROM (
          SELECT conversation_id, json_extract(payload, '$.title') AS title
            FROM events
           WHERE seq IN (
             SELECT MAX(seq) FROM events
              WHERE type = 'conversation.renamed'
              GROUP BY conversation_id
           )
        ) AS latest
       WHERE conversations.id = latest.conversation_id;
    `,
  },
  {
    version: 20,
    name: 'the-commands-a-project-runs',
    up: `
      ALTER TABLE projects ADD COLUMN run_commands TEXT;
    `,
  },
  {
    version: 21,
    name: 'a-chat-keeps-one-note',
    up: `
      CREATE TABLE conversation_note (
        conversation_id TEXT    PRIMARY KEY,
        body            TEXT    NOT NULL DEFAULT '',
        revision        INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
        version         INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
        visible         INTEGER NOT NULL DEFAULT 0 CHECK (visible IN (0, 1)),
        x               REAL    CHECK (x IS NULL OR (x >= 0 AND x <= 1)),
        y               REAL    CHECK (y IS NULL OR (y >= 0 AND y <= 1)),
        width           REAL    CHECK (width IS NULL OR (width >= 0 AND width <= 1)),
        height          REAL    CHECK (height IS NULL OR (height >= 0 AND height <= 1)),
        updated_by      TEXT,
        updated_at      INTEGER NOT NULL DEFAULT 0,
        journal         TEXT
      );
    `,
  },
  {
    version: 22,
    name: 'a-review-remembers-what-was-read',
    up: `
      CREATE TABLE review_viewed (
        host       TEXT    NOT NULL,
        project    TEXT    NOT NULL,
        iid        INTEGER NOT NULL,
        path       TEXT    NOT NULL,
        digest     TEXT    NOT NULL,
        viewed_at  INTEGER NOT NULL,
        PRIMARY KEY (host, project, iid, path)
      );
      CREATE TABLE review_seen (
        host       TEXT    NOT NULL,
        project    TEXT    NOT NULL,
        iid        INTEGER NOT NULL,
        version_id INTEGER NOT NULL,
        head_sha   TEXT    NOT NULL,
        seen_at    INTEGER NOT NULL,
        PRIMARY KEY (host, project, iid)
      );
    `,
  },
]

export interface MigrationResult {
  readonly from: number
  readonly to: number
  readonly applied: readonly string[]
  readonly backedUpTo: string | null
}

export function currentVersion(db: Database): number {
  const row = db.prepare('PRAGMA user_version').get()
  const parsed = row as { user_version?: number } | undefined
  return parsed?.user_version ?? 0
}

/**
 * `backup` is injected rather than called directly because it is the one async
 * method on better-sqlite3 (S4) and the port is otherwise synchronous. Callers
 * that can snapshot pass one in; tests and in-memory databases pass nothing.
 */
export function migrate(
  db: Database,
  onBeforeMigrate?: (from: number) => string | null
): MigrationResult {
  const from = currentVersion(db)
  const pending = MIGRATIONS.filter((m) => m.version > from)

  if (pending.length === 0) {
    return { from, to: from, applied: [], backedUpTo: null }
  }

  // Snapshot before touching a database that already holds data. A failed
  // migration on an empty database costs nothing; on a real one it costs
  // everything.
  const backedUpTo = from > 0 ? (onBeforeMigrate?.(from) ?? null) : null

  const run = db.transaction(() => {
    for (const m of pending) {
      db.exec(m.up)
      db.exec(`PRAGMA user_version = ${String(m.version)}`)
    }
  })
  run()

  const to = pending.at(-1)?.version ?? from
  return { from, to, applied: pending.map((m) => m.name), backedUpTo }
}
