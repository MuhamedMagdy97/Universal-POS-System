import type { en } from "./messages/en";

export const LOCALES = ["en", "ar"] as const;
export type Locale = (typeof LOCALES)[number];

export type MessageKey = keyof typeof en;

/** A full translation: every key, string values. */
export type Messages = Record<MessageKey, string>;

/** Placeholder names in a message, e.g. "No match for {q}" → "q". */
type PlaceholderNames<S extends string> = S extends `${string}{${infer Name}}${infer Rest}`
  ? Name | PlaceholderNames<Rest>
  : never;

export type MessageParams<K extends MessageKey> = Record<PlaceholderNames<(typeof en)[K]>, string | number>;

/** Params are required exactly when the English message has placeholders. */
export type MessageArgs<K extends MessageKey> = [PlaceholderNames<(typeof en)[K]>] extends [never]
  ? []
  : [params: MessageParams<K>];
