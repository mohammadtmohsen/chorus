# Chorus for VS Code

Lets [Chorus](https://github.com/mohammadtmohsen/chorus) see which file you are in and
which lines you have selected, so you can ask about them without describing where they
are.

## What it sends

Only for a project Chorus already has open. The extension is told which folders those are
and reports nothing about anything else — a file from another project never leaves the
editor, not even as a path.

While you work it sends **metadata only**: the file, the line range, its language, and
whether the buffer is unsaved. No source code crosses until you press Send in Chorus, and
then only for the selection you can see named in the composer.

In a restricted workspace it reports that the window exists and nothing more.

## How it connects

Chorus listens on a Unix domain socket owned by your user account; this extension dials
out to it. Nothing listens inside VS Code, so no web page can reach it. If Chorus is not
running, the extension idles and retries.

## Install

Chorus installs this for you — **Install VS Code Extension** in the app. It ships the
version matching your Chorus build, so the two always speak the same protocol.

## Commands

- **Chorus: Reconnect** — drop and re-establish the connection.

The status bar shows `Chorus: linked` or `Chorus: not running`.
