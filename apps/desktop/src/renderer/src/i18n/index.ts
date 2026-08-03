import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from './en.json'

/**
 * Wired from day 1 on purpose. Retrofitting i18n means auditing every string in
 * the app; adding a locale later then costs nothing.
 */
export const defaultNS = 'translation'
export const resources = { en: { translation: en } } as const

void i18n.use(initReactI18next).init({
  resources,
  lng: 'en',
  fallbackLng: 'en',
  defaultNS,
  interpolation: { escapeValue: false },
})

export default i18n
