# How PostHog's browser SDK (posthog-js) tracks visitors


## What Jun takes from it (D-107, as of 2026-10-18)

Jun's loader is a support tool, not an analytics tracker (N-08): a masked trail of the last 40 events, sent only with a visitor's message; no autocapture, no stored event history, no cookies; under 6 KB gzipped against posthog-js's ~106 KB.

| | PostHog | Jun |
|---|---|---|
| Rage click | 3rd click within 30 px and 1 s | Same thresholds, and only when the page didn't visibly react (S-02) |
| Dead click | No DOM change in 2.5 s, no scroll or selection change in 100 ms | Taken: one click on a button or link, nothing changes, scrolls, submits or navigates for 2.5 s (S-17) |
| Session | UUIDv7 shared by tabs; new after 30 min idle or 24 h | Taken: localStorage `jun:session`, same rule, after consent only (V-12) |
| Campaign tags | `utm_*` kept as properties | Taken: utm values kept in cleaned URLs; the session keeps the landing page's (V-13) |
| Bots | 77 user-agent strings + `navigator.webdriver` dropped | Taken, shorter pattern (`BOT_UA`), live list only (V-14) |
| Page views | `$pageview` incl. history changes | Landing page + how reached (open / reload / back) and in-app navigation, hash routes (S-16) |
| Identity | `identify(id)` from page code | Signed JWT checked on the server (V-03); unchanged |
| Autocapture, heatmaps, web vitals, replay | On (replay per project) | Not taken (N-08) |

Found while checking: PostHog now ships its own support chat (`conversations`, ≈22 KB, on by default) with an HMAC identity check, and a WebMCP extension that records `document.modelContext` tool calls.

*As of 2026-10-18.* Read from the published source of **posthog-js 1.438.12** (npm, published 2026-10-15), with its dependencies **@posthog/browser-common 0.9.5**, **@posthog/core 1.59.1** and **@posthog/types 1.416.0**. The npm `lib/src/*.js` files are the TypeScript compiled 1:1, so each source link below points at the matching `.ts` file in the monorepo (`packages/browser/src/…`, `packages/browser-common/src/…`, `packages/core/src/…`). Docs claims are marked as docs. Where the docs and the code disagree, the code wins and the gap is noted.

Shorthand used in links:
- `browser/` = https://github.com/PostHog/posthog-js/blob/main/packages/browser/src/
- `common/` = https://github.com/PostHog/posthog-js/blob/main/packages/browser-common/src/
- `core/` = https://github.com/PostHog/posthog-js/blob/main/packages/core/src/

Package: https://www.npmjs.com/package/posthog-js · Repo: https://github.com/PostHog/posthog-js

---

## 0. The `defaults` snapshot mechanism (read this first)

Many defaults now depend on a `defaults: '<date>'` init option. Older installs default to `'unset'` and keep the legacy behaviour. From `defaultsThatVaryByConfig` in `posthog-core.ts`:

| Option | `'unset'` (legacy) | Changes with snapshot |
|---|---|---|
| `capture_pageview` | `true` (initial load only) | `'history_change'` from `2025-05-24` |
| `rageclick` | `true` | `{content_ignorelist: true}` from `2025-11-30`; `{content_ignorelist: [steppers too], ignore_text_selection: true}` from `2026-05-30` |
| `session_recording.strictMinimumDuration` | — | `true` from `2025-11-30` |
| `session_recording.canvasCapture` | — | `{resolutionScale: 0.6}` from `2026-05-30` |
| `session_recording.streamNetworkBody` | — | `true` from `2026-06-25` |
| `session_recording.captureJsonLd` | — | `true` from `2026-08-30` |
| `external_scripts_inject_target` | `'body'` | `'head'` from `2026-01-30` |
| `internal_or_test_user_hostname` | none | `/^(localhost|127\.0\.0\.1)$/` from `2026-01-30` |
| `persistence_save_debounce_ms` | `0` | `250` from `2026-05-30` |
| `split_storage` | `false` | `true` from `2026-05-30` |
| `disable_capture_url_hashes` | `false` | `true` from `2026-06-25` |
| `cookieWinsOnConflict` | `false` | `true` from `2026-08-29` |

Sources: `browser/posthog-core.ts` (`defaultsThatVaryByConfig`, `defaultConfig`) https://github.com/PostHog/posthog-js/blob/main/packages/browser/src/posthog-core.ts. Docs list the snapshot dates `'2025-05-24'`, `'2025-11-30'`, `'2026-01-30'`, `'2026-05-30'`, `'2026-06-25'`, `'2026-08-29'`, `'2026-08-30'`: https://posthog.com/docs/libraries/js/config

Defaults that do not vary (from `defaultConfig`): `api_host: 'https://us.i.posthog.com'`, `autocapture: true`, `persistence: 'localStorage+cookie'`, `cookie_expiration: 365` (days), `cross_subdomain_cookie: isCrossDomainCookie(location)`, `secure_cookie: location.protocol === 'https:'`, `save_campaign_params: true`, `save_referrer: true`, `capture_pageleave: 'if_capture_pageview'`, `session_idle_timeout_seconds: 1800`, `person_profiles: 'identified_only'`, `request_batching: true`, `properties_string_max_length: 65535`, `mask_all_text: false`, `mask_all_element_attributes: false`, `mask_personal_data_properties: false`, `respect_dnt: false`, `opt_out_capturing_by_default: false`, `opt_out_capturing_persistence_type: 'localStorage'`, `opt_out_useragent_filter: false`, `disable_session_recording: false`, `disable_web_experiments: true`, `disable_compression: false`, `feature_flag_request_timeout_ms: 3000`, `request_queue_config.flush_interval_ms: 3000`, `ip: false` (deprecated, "has NO EFFECT AT ALL").

---

## 1. Identity

### distinct_id generation
- On first load, if nothing is persisted, the SDK makes **one UUIDv7** and stores it as both `distinct_id` and `$device_id`, then sets `$user_state = 'anonymous'`: `const uuid = this.config.get_device_id(uuidv7()); this.register_once({ distinct_id: uuid, $device_id: uuid }, '')`. `get_device_id` is a config hook (default: identity). Source: `browser/posthog-core.ts` (`_init`). The UUIDv7 implementation is `common/utils/uuidv7.ts`: https://github.com/PostHog/posthog-js/blob/main/packages/browser-common/src/utils/uuidv7.ts
- Every event also gets its own `uuid` (UUIDv7, via `getEventUuid(options.uuid, uuidv7)`), used for server-side dedupe. Source: `browser/posthog-core.ts` (`capture`).
- `bootstrap: { distinctID, isIdentifiedID, sessionID }` lets a server hand the ID to the page (for SSR or cross-domain). With `isIdentifiedID: true`, `$device_id` becomes a fresh UUIDv7 and the state is `identified`. Source: same file.

### Anonymous vs identified
- `$user_state` is persisted as `'anonymous'` or `'identified'`. Every event carries `$is_identified` (boolean). Source: `browser/posthog-core.ts` (`calculateEventProperties`), constants in `browser/constants.ts` https://github.com/PostHog/posthog-js/blob/main/packages/browser/src/constants.ts
- **`identify(newId, $set?, $set_once?)`**:
  - Rejects empty IDs, the cookieless sentinel `$posthog_cookieless`, hard-coded-looking strings (`isDistinctIdStringLike`) and `'undefined'`/`'null'` (`_validateIdentifyId`).
  - Registers `$user_id: newId`. If no `$device_id` is stored, the previous ID becomes the device ID and `$had_persisted_distinct_id: true` is set.
  - If the state was anonymous and the ID changes, it sends **`$identify`** with `{ distinct_id: newId, $anon_distinct_id: previousId }` plus `$set` / `$set_once`, and flips the state to identified. With `reuseAnonymousId: true`, `$anon_distinct_id` is left out.
  - If the ID is unchanged but the state was anonymous, it only sends a `$set` event.
  - Otherwise, passed properties go through `setPersonProperties` (a `$set` event).
  - It reloads feature flags when the identity changed.
  - Source: `browser/posthog-core.ts` (`identify`).
- **`alias(alias, original = current distinct_id)`**: sends `$create_alias` with `{ alias, distinct_id: original }` and stores `__alias`. If `alias === original`, it calls `identify(alias)` instead. Source: same file (`alias`).
- **`reset(resetDeviceID?)`**:
  - Clears both persistences and session-registered props.
  - Resets consent (unless it is a consent transition), flags, surveys, conversations, logs and metrics.
  - Sets the state to anonymous, starts a **new session ID**, and makes a new UUIDv7 `distinct_id`.
  - Keeps the old `$device_id` unless `resetDeviceID` is true.
  - Registers `$last_posthog_reset` (ISO time).
  - Source: same file (`reset` / `_reset`). Docs: "Calling `posthog.reset()` starts a new session and a new session replay." https://posthog.com/docs/data/sessions

### Person profiles (`person_profiles`)
- Default **`'identified_only'`**. `_hasPersonProcessing()` is false only when the mode is identified_only **and** the user is not identified, has no groups, no `__alias`, and no `$epp` (enable-person-processing) flag. `'never'` blocks `identify`/`alias`/`createPersonProfile`. `'always'` processes everyone. Every event carries `$process_person_profile: true|false`. Calling `identify`, `alias`, `setPersonProperties`, `createPersonProfile` or `group` sets `$epp = true` permanently (`_requirePersonProcessing`). Source: `browser/posthog-core.ts` (`_hasPersonProcessing`, `_requirePersonProcessing`).
- Docs: identified_only is the default. The calls that create a profile on web are `identify()`, `alias()`, `group()`, `setPersonProperties()` and `setGroupPropertiesForFlags()`. "Anonymous events can be up to 4x cheaper than identified ones" *(vendor claim)*. https://posthog.com/docs/data/anonymous-vs-identified-events

### Groups (company-level analytics)
- `group(type, key, props?)` registers `$groups: { ...existing, [type]: key }` as a super property, so every later event carries `$groups`. When the group is new or props are passed (and person processing is on), it sends **`$groupidentify`** with `$group_type`, `$group_key` and optional `$group_set`. `resetGroups()` clears them. Source: `browser/posthog-core.ts` (`group`, `resetGroups`).

### HMAC identity verification (new; used by PostHog's support "Conversations")
- Config `identity_distinct_id` + `identity_hash` ("HMAC-SHA256 of `identity_distinct_id`, signed with the Secret API key from Support settings"), plus optional `identity_claims: Record<string, {value, hash}>`; also `posthog.setIdentity()`. If set without a bootstrap ID, it becomes `bootstrap: { distinctID, isIdentifiedID: true }`. Source: `@posthog/types` `posthog-config.d.ts` https://github.com/PostHog/posthog-js/blob/main/packages/types/src/posthog-config.ts *(path inferred from package layout)*; `browser/posthog-core.ts`.
- Worth noting for Jun: PostHog now ships a support/chat product inside the SDK (`conversations`, `disable_conversations: false` default, lazily loaded `conversations.js` ≈22 KB gz).

---

## 2. Persistence

| `persistence` | Store used (`posthog-persistence.ts` `_buildStorage`) |
|---|---|
| `'localStorage+cookie'` **(default)** | localStorage for everything, plus a cookie holding only the `COOKIE_PERSISTED_PROPERTIES` |
| `'cookie'` | everything in the cookie |
| `'localStorage'` | everything in localStorage |
| `'sessionStorage'` | everything in sessionStorage |
| `'memory'` | in-page object only (gone on reload) |

If the chosen store is unsupported, it falls back to localStorage+cookie, then cookie, then memory. Source: `browser/posthog-persistence.ts` https://github.com/PostHog/posthog-js/blob/main/packages/browser/src/posthog-persistence.ts

- **Name:** `ph_<token>_posthog`, or `ph_<persistence_name>` if that option is set. Source: same file.
- **What goes in the cookie** (`COOKIE_PERSISTED_PROPERTIES` in `storage.ts`): `$device_id`, `distinct_id`, `$sesid`, `$session_recording_is_sampled` (constant name), `$epp`, `$initial_person_info`, `$fbc_persistence`, `$user_state`. A companion `<name>_cpm` cookie holds metadata for custom `cookie_persisted_properties`. Source: `browser/storage.ts` https://github.com/PostHog/posthog-js/blob/main/packages/browser/src/storage.ts
- **`$sesid`** = `[lastActivityTimestamp, sessionId, sessionStartTimestamp]`. Source: `browser/sessionid.ts`.
- **What stays in localStorage:**
  - super properties
  - feature flags and payloads
  - surveys
  - stored person/group props for flags
  - `$client_session_props`
  - `$initial_campaign_params`, `$initial_referrer_info`
  - the rate-limit bucket
  - replay remote config
  - many SDK debug keys

  Keys are classed `hidden` (not added to events) or `event` (added to every event). Source: `browser/persistence-key-policy.ts` https://github.com/PostHog/posthog-js/blob/main/packages/browser/src/persistence-key-policy.ts
- **Cookie attributes:** `SameSite=Lax; path=/`, `expires = 365 days`, `secure` on https, value is URI-encoded JSON. It warns when the cookie exceeds ~3.7 KB (90 % of 4096). Source: `browser/storage.ts` (`cookieStore._set`).
- **Cross-subdomain:** on by default unless the last two host labels are `herokuapp.com`, `vercel.app` or `netlify.app` (`isCrossDomainCookie`, `common/utils/general-utils.ts`). The cookie domain is found by `seekFirstNonPublicSubDomain`, which writes a probe cookie `dmn_chk_<uuidv7>` on ever-longer suffixes until the browser accepts one, so public suffixes are skipped. The fallback is the regex `/[a-z0-9][a-z0-9-]+\.[a-z]{2,}$/i`. Source: `browser/storage.ts`; https://github.com/PostHog/posthog-js/blob/main/packages/browser-common/src/utils/general-utils.ts
- **`cookieWinsOnConflict`** (≥1.418.0): the shared cookie is authoritative over origin-local localStorage for its keys. Docs: https://posthog.com/docs/libraries/js/persistence
- **sessionStorage keys** (per tab): `ph_<name>_window_id`, `ph_<name>_primary_window_exists`, `ph_<name>_session_registered_properties`. Source: `browser/sessionid.ts`, `browser/posthog-core.ts`.
- **Consent** is stored separately: `__ph_opt_in_out_<token>` (1/0), in localStorage by default (`opt_out_capturing_persistence_type`). Docs: consent "is not shared by default" across subdomains. Sources: `browser/consent.ts` https://github.com/PostHog/posthog-js/blob/main/packages/browser/src/consent.ts; https://posthog.com/docs/libraries/js/persistence

---

## 3. Sessions

| Rule | Value | Source |
|---|---|---|
| Idle timeout | **30 min** (`session_idle_timeout_seconds`, clamped **60 s–10 h**) | `browser/sessionid.ts` |
| Max length | **24 h** (`SESSION_LENGTH_LIMIT_MILLISECONDS`) | same |
| ID format | UUIDv7 (the start time is recoverable from the ID, `uuid7ToTimestampMs`) | same |
| Activity persistence granularity | 5 s (`ACTIVITY_TIMESTAMP_PERSIST_GRANULARITY_MS`) | same |
| Cookie re-sync for replay checks | every 1 s max | same |
| Proactive idle check | timer at `timeout × 1.1`; fires `forcedIdleReset` if every tab is idle | same |

- **A new session starts when** there is no session ID, the activity timeout passes, or the session passes its maximum length. The change reason (`noSessionId` / `activityTimeout` / `sessionPastMaximumLength` / `crossTabAdoption`) is given to listeners. A sibling tab's rotated ID is adopted ("adopted cross-tab session id"). Source: `browser/sessionid.ts` (`checkAndGetSessionAndWindowId`) https://github.com/PostHog/posthog-js/blob/main/packages/browser/src/sessionid.ts
- **Activity:** each captured event (not read-only calls) updates the activity timestamp. Docs say any client event counts, "including autocapture events and replay activity like mouse movement". https://posthog.com/docs/data/sessions
- **`$session_id`** and **`$window_id`** are on every event (`calculateEventProperties`).
- **`$window_id`** lives in sessionStorage. It survives reloads of the same tab. A duplicated tab or `window.open` copies sessionStorage, but `primary_window_exists` is still set there (it is only cleared on `beforeunload`), so the copy gets a **new** window ID. Source: `browser/sessionid.ts` (`_listenToReloadWindow` comment).
- **`$configured_session_timeout_ms`** is registered as a super property.
- **Session entry props:** `SessionPropsManager` stores the first URL, referrer and UTMs per session and adds them to events as `$session_entry_*` (`$session_entry_url`, `$session_entry_referrer`, …). Source: `browser/session-props.ts` https://github.com/PostHog/posthog-js/blob/main/packages/browser/src/session-props.ts
- **Server-computed session props** (docs): `$session_duration`, `$entry_*`, `$exit_*`, `$is_bounce` (single-pageview session), `$pageview_count`, `$autocapture_count`. https://posthog.com/docs/data/sessions
- `register_for_session()` props are cleared when the session rotates.

---

## 4. Automatic events

### `$pageview`
- **Initial pageview:** fired 1 ms after load if opted in or cookieless. It is **deferred until `document.visibilityState === 'visible'`** (prerendered or background tabs wait). Source: `browser/posthog-core.ts` (`_loaded`, `_captureInitialPageview`).
- **SPA navigation:** `HistoryAutocapture` patches `history.pushState` / `replaceState` and listens to `popstate`. With `capture_pageview: 'history_change'` (default from snapshot 2025-05-24) it fires when **`pathname` changes**. An object form `{path, search, hash}` picks what counts, and hash is ignored when `disable_capture_url_hashes` is set. The event carries `navigation_type: 'pushState'|'replaceState'|'popstate'`. Source: `browser/extensions/history-autocapture.ts` https://github.com/PostHog/posthog-js/blob/main/packages/browser/src/extensions/history-autocapture.ts
- **Pageview properties** (`PageViewManager`): `$pageview_id` (the pageview event's UUID, added to every later event), `$prev_pageview_id`, `$prev_pageview_pathname`, `$prev_pageview_duration` (s), and scroll depth of the previous page: `$prev_pageview_last_scroll`, `_last_scroll_percentage`, `_max_scroll`, `_max_scroll_percentage`, `_last_content`, `_last_content_percentage`, `_max_content`, `_max_content_percentage`. It also adds `title` (= `document.title`). Scroll tracking can be turned off with `disable_scroll_properties`. Sources: `browser/page-view.ts` https://github.com/PostHog/posthog-js/blob/main/packages/browser/src/page-view.ts, `browser/scroll-manager.ts`

### `$pageleave`
- Sent from the `pagehide` listener (`unload` where `pagehide` is missing) when `capture_pageleave` is `true`, or is `'if_capture_pageview'` (default) and pageviews are on. It carries the same `$prev_pageview_*` scroll and duration fields. Source: `browser/posthog-core.ts` (`_handle_unload`, `_shouldCapturePageleave`).

### `$autocapture`
- **Listeners:** document-level capture-phase `click`, `change` and `submit` (plus `copy`/`cut` when `capture_copied_text`). Source: `browser/autocapture.ts` https://github.com/PostHog/posthog-js/blob/main/packages/browser/src/autocapture.ts
- **Which elements** (`shouldCaptureDomEvent`, `common/utils/autocapture-utils.ts`):
  - `a`, `button`, `form` (submit only), `input`/`select`/`textarea` (change and click), `label`
  - any element with `contenteditable="true"`
  - any element whose parent chain has one of the above
  - **any element with computed `cursor: pointer`** (clicks)

  The filters are `url_allowlist` / `url_ignorelist`, `dom_event_allowlist`, `element_allowlist`, `css_selector_allowlist`, and `css_selector_ignorelist` (default `['.ph-no-autocapture', '[data-ph-no-autocapture]']`). https://github.com/PostHog/posthog-js/blob/main/packages/browser-common/src/utils/autocapture-utils.ts
- **Properties:**
  - `$event_type` (`click`/`change`/`submit`), `$ce_version: 1`
  - **`$elements_chain`**: a string of the target and its ancestors up to `<body>`, max depth 1000, crossing shadow roots. Each element gives `tag_name`, `$el_text`, `classes`, `attr__<name>` for every attribute (values ≤1024 chars), `nth_child` and `nth_of_type`.
  - `$el_text` (top level)
  - `$external_click_url` when an `<a href>` points at another host
  - `$element_selectors` when the toolbar or actions need them
  - any `data-ph-capture-attribute-<key>="value"` on the element or its ancestors becomes property `<key>`
  - `$elements` (the JSON array) is "deprecated"; only `$elements_chain` is sent by default

  For an SVG click inside a button or link, the button or link becomes the target. Source: `browser/autocapture.ts`.
- **Sensitive-data rules:**
  - Text is collected only from direct text nodes (`getSafeText`). Each whitespace-separated token is dropped if it looks like a **credit card** (Luhn-style regexes for Visa/MC/Amex/Discover/Diners/JCB) or a **US SSN**. Text is capped at 255 chars per text call and 1024 per element.
  - `$el_text` is never taken from inputs, selects, textareas or contenteditable elements (`isSensitiveElement`). For those, only the `name`, `id`, `class` and `aria-label` attributes are kept. **Input values are never captured.**
  - An element is skipped entirely (`shouldCaptureElement` false) when it or an ancestor has class `ph-sensitive` or `ph-no-capture`, when it is `type=hidden` or `type=password`, or when its `name`/`id` matches `/^cc|cardnum|ccnum|creditcard|csc|cvc|cvv|exp|pass|pwd|routing|seccode|securitycode|securitynum|socialsec|socsec|ssn/i`. `ph-include` overrides this.
  - **`ph-no-capture`** anywhere in the chain drops the whole event.
  - `mask_all_text: true` drops `$el_text`. `mask_all_element_attributes: true` drops classes and all `attr__*`. `element_attribute_ignorelist` drops named attributes. Angular `_ngcontent`/`_nghost` attributes are dropped.
  - Sources: `common/utils/autocapture-utils.ts`; `browser/autocapture.ts`.
- **Remote kill switch:** the project setting `autocapture_opt_out` (persisted `$autocapture_disabled_server_side`).

### `$rageclick`
- **Definition:** the **3rd click** where each click lands within **30 px Manhattan distance** (`|dx|+|dy| < 30`) and **< 1000 ms** of the previous one. `rageclick: { threshold_px, timeout_ms, click_count }` overrides this. Source: `browser/extensions/rageclick.ts` https://github.com/PostHog/posthog-js/blob/main/packages/browser/src/extensions/rageclick.ts
- **Suppression:** ignored when the target chain matches `.ph-no-rageclick` or `.ph-no-capture`. With `content_ignorelist`, it is ignored when the clicked control's text or aria-label is a pager or stepper word (`next`, `previous`, `prev`, `>`, `<`, `→`, `←`, `›`, `‹`, `»`, `«`, `▶`, `◀`, `❯`, `❮`, plus `+ - − –` from snapshot 2026-05-30). With `ignore_text_selection`, clicks in text inputs, textareas and contenteditable elements are ignored. Source: `common/utils/autocapture-utils.ts` (`shouldCaptureRageclick`).
- The event carries the same element properties as `$autocapture`. Docs match: "three clicks within 30 pixels and 1 second". https://posthog.com/docs/product-analytics/autocapture

### `$dead_click` (and `$dead_swipe`)
- **Enabled when:** `capture_dead_clicks` is set on the client, else by the project setting (`$dead_clicks_enabled_server_side`). Code: `isDeadClicksEnabledForAutocapture`. The docs config page says the default is `true`; the code falls back to the remote setting when unset. **Discrepancy noted.** The detector is a lazy chunk `dead-clicks-autocapture.js` (~8.5 KB gz).
- **Defaults:** `scroll_threshold_ms: 100`, `selection_change_threshold_ms: 100`, `mutation_threshold_ms: 2500`, `capture_clicks_with_modifier_keys: false`, `capture_dead_swipes: true`, `swipe_threshold_px: 30`, `max_dead_swipes_per_page_load: 10`.
- **How it works:** each click is queued and re-checked about 1 s later. It counts as **alive** (dropped) if any of these happen within its window:
  - a DOM mutation within 2.5 s
  - a scroll within 100 ms
  - a selection change during the gesture or within ±100 ms
  - a visibilitychange or focus/blur within ±1 s

  It counts as **dead** if no liveness signal fired and a timeout fired (a mutation, scroll or selection that came too late, or nothing at all within `2500 × 1.1` ms).
- **Never candidates:** clicks on anchors (swipes still count), the same node clicked again within 1 s, modifier-key clicks, the toolbar, and `.ph-no-deadclick` / `.ph-no-capture`.
- **Properties:** `$dead_click_scroll_delay_ms`, `_mutation_delay_ms`, `_absolute_delay_ms`, `_selection_changed_delay_ms`, `_visibility_changed_delay_ms`, `_focus_changed_delay_ms`, `_last_mutation_timestamp`, `_absolute_timeout`, plus the autocapture element properties.
- Sources: https://github.com/PostHog/posthog-js/blob/main/packages/browser/src/entrypoints/dead-clicks-autocapture.ts, https://github.com/PostHog/posthog-js/blob/main/packages/browser/src/extensions/dead-clicks-autocapture.ts. Docs: "a click which isn't followed by a change to the page". https://posthog.com/docs/product-analytics/autocapture

### `$exception` (exception autocapture)
- `capture_exceptions` defaults to `undefined`, which means the project setting decides. When on, it captures `window.onerror` and `unhandledrejection`. `capture_console_errors` is opt-in. A per-exception-type token bucket allows a burst of **10**, then **1 per 10 s** (`exceptionRateLimiterBucketSize` is tunable).
- Properties: `$exception_list`, `$exception_types`, `$exception_values`, and optional `$exception_steps`.
- Use `posthog.captureException(err)`. A manual `capture('$exception')` logs a warning.
- Sources: https://github.com/PostHog/posthog-js/blob/main/packages/browser/src/extensions/exception-autocapture/index.ts, `browser/posthog-exceptions.ts`

### `$web_vitals`
- **Enabled by:** `capture_performance` (or `{ web_vitals: bool }`), else the project setting. Only on http(s).
- **Metrics:** `CLS`, `FCP`, `INP`, `LCP`, from Google's `web-vitals` 6.2.1 in a lazy chunk (~4 KB gz; attribution build ~7 KB). INP and LCP get attribution by default; CLS does not ("holds detached DOM nodes and leaks").
- **Buffering:** metrics are buffered per navigation and flushed when all allowed metrics are in, on navigation change, or after **5 s** (`web_vitals_delayed_flush_ms`). Values ≥ a max (described in comments as "LCP > 1 hour") are dropped.
- Properties: `$web_vitals_<M>_value` and `$web_vitals_<M>_event`.
- Source: https://github.com/PostHog/posthog-js/blob/main/packages/browser/src/extensions/web-vitals/index.ts

### Heatmaps (`$$heatmap`)
- Listens to document `click` and `mousemove` (debounced 500 ms). Each point is `{x, y, target_fixed, type}` with type `click`/`rageclick`/`deadclick`/`mousemove`. Coordinates are page coordinates (scroll added) unless the element is fixed or sticky.
- Points are buffered per masked URL and flushed every **5 s** as one `$$heatmap` event with `$heatmap_data: { [url]: points[] }`.
- Enabled by `capture_heatmaps` (`true`/`false`/`{ flush_interval_milliseconds }`), else the legacy `enable_heatmaps`, else the project setting (`Heatmaps.isEnabled`).
- Docs: heatmaps "create no additional events" *(they ride on the `$$heatmap` system event)*. Scroll-depth heatmaps use the `$prev_pageview_*` scroll fields on `$pageview`/`$pageleave` *(inferred)*.
- Sources: https://github.com/PostHog/posthog-js/blob/main/packages/browser/src/heatmaps.ts; https://posthog.com/docs/product-analytics/autocapture

### `$copy_autocapture`
- With `capture_copied_text: true`, `copy` and `cut` events send the selected text, passed through `makeSafeText` (CC/SSN tokens removed, ≤255 chars), as `$selected_content`, plus `$clipboard_text_length` and `$copy_type`. Paste content is never sent. Selections in sensitive elements are not captured. Source: `browser/autocapture.ts`; docs https://posthog.com/docs/product-analytics/autocapture

### Other automatic events
- `$opt_in`: sent instantly on `opt_in_capturing()`.
- `$identify`, `$create_alias`, `$groupidentify`, `$set`: see section 1.
- `$feature_flag_called`: may be minimised.
- `$$client_ingestion_warning`: sent when client rate limiting drops events.
- `$mcp_tool_call`: the new **WebMCP** extension. With `capture_webmcp`, it patches `document.modelContext.registerTool` and logs each tool call with `$mcp_tool_name`, `$mcp_duration_ms`, `$mcp_is_error`, etc. Source: https://github.com/PostHog/posthog-js/blob/main/packages/browser/src/extensions/webmcp.ts

---

## 5. Default properties on every event

From `getEventProperties` (`common/utils/event-utils.ts`) https://github.com/PostHog/posthog-js/blob/main/packages/browser-common/src/utils/event-utils.ts and `calculateEventProperties` (`browser/posthog-core.ts`):

| Group | Properties |
|---|---|
| Page | `$current_url` (full href; hash stripped with `disable_capture_url_hashes`; ad click-ID params replaced by `<masked>` when `mask_personal_data_properties`), `$host`, `$pathname`, `title` (pageview only) |
| Device / UA | `$os`, `$os_version`, `$browser`, `$browser_version`, `$device`, `$device_type` (uses `userAgentData.platform`, `maxTouchPoints`, screen size, DPR), `$device_model` (async, unless `disableDeviceModel`), `$webview_app`, `$webview_app_version`, `$raw_user_agent` (≤1000 chars) |
| Screen | `$screen_height`, `$screen_width`, `$viewport_height`, `$viewport_width` |
| Locale | `$browser_language`, `$browser_language_prefix`, `$timezone`, `$timezone_offset` |
| Library | `$lib` (`'web'`), `$lib_version`, `$config_defaults`, `$lib_custom_api_host` (custom host), `$lib_rate_limit_remaining_tokens`, `$sdk_debug_*` |
| Dedupe / time | `uuid` (UUIDv7, event-level), `$insert_id` (16 random base36 chars), `$time` (epoch s), `timestamp` (event level), `sent_at` (batch level), `$event_time_override_*` when a timestamp is passed |
| Identity | `distinct_id`, `$device_id`, `$user_id`, `$is_identified`, `$process_person_profile`, `$groups`, `token` |
| Session | `$session_id`, `$window_id`, `$pageview_id`, `$session_entry_*`, `$configured_session_timeout_ms`, `$initialization_time` |
| Referrer | `$referrer` / `$referring_domain` (`'$direct'` when empty; kept per session, the persisted copy wins), `$search_engine` (google/bing/yahoo/duckduckgo) and `ph_keyword` |
| Campaign | `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term`, `gad_source`, `mc_cid`, and click IDs `gclid`, `gclsrc`, `dclid`, `gbraid`, `wbraid`, `fbclid`, `msclkid`, `twclid`, `li_fat_id` (also read from the cookie), `igshid`, `ttclid`, `rdt_cid`, `epik`, `qclid`, `sccid`, `oppref`, `bfcid`, `irclid`, `_kx`; plus `custom_campaign_params`. Meta `$fbc`/`$fbp` are derived for person `$set`. |
| Person (`$set_once`, first event with person processing) | `$initial_referrer`, `$initial_referring_domain`, `$initial_current_url`, `$initial_host`, `$initial_pathname`, `$initial_utm_*`, `$initial_gclid` … (from `$initial_person_info` = `{r: referrer ≤1000, u: url ≤1000}` stored in the cookie) |
| Bots | `$browser_type: 'bot'|'browser'` only when `opt_out_useragent_filter: true` |

The `EVENT_TO_PERSON_PROPERTIES` list (browser, OS, device type, URL, referrer, screen/viewport, raw UA, …) is what gets copied to person properties. Strings are truncated to `properties_string_max_length` (65,535). Super properties come from `register()`.

---

## 6. Transport

| Aspect | Value | Source |
|---|---|---|
| Endpoint (events) | `POST {api_host}/e/` by default (`analyticsDefaultEndpoint = '/e/'`); remote config can switch it (`config.analytics.endpoint`, e.g. `/i/v0/e/`) | `browser/posthog-core.ts` |
| Default hosts | `https://us.i.posthog.com` (EU `eu.i.posthog.com`); assets on `https://us-assets.i.posthog.com/static/…` | `browser/utils/request-router.ts` |
| Replay endpoint | `/s/` (batch key `recordings`, grouped per session and window) | `browser/extensions/replay/external/lazy-loaded-session-recorder.ts` |
| Config | `GET {assets}/array/<token>/config` (static, CDN); flags `/flags/?v=2` | `browser/remote-config.ts` |
| Batching | queue flush every **3000 ms** (`flush_interval_ms`, clamped 250–5000); batches per URL+batchKey | `browser/request-queue.ts` |
| Body | `{ api_key, batch: [...events], sent_at }` | `browser/request.ts` (`addSentAtToCaptureBody`) |
| Compression | **gzip** via fflate `gzipSync` (or native `CompressionStream` async), sent as binary `text/plain` (CORS-simple, no preflight); falls back to base64 form-encoded (`compression=base64`) or plain JSON. Remote config's `supportedCompression` picks gzip-js > base64. Older SDKs sent `?compression=gzip-js`; the current one drops that param for gzip *(how the server detects it is not verified; presumably by sniffing)* | `browser/request.ts`, `browser/posthog-core.ts` (`_onRemoteConfig`) |
| Transports | fetch (preferred) → XHR → sendBeacon; fetch timeout 60 s; `referrerPolicy: 'strict-origin'` | `browser/request.ts` |
| keepalive | fetch `keepalive` used while pending keepalive bytes stay < **80 % of 64 KiB** (~52 KB) | same |
| Unload | on `pagehide`: send `$pageleave`, then flush the queue and retry queue via **sendBeacon** (base64 if not compressed); a rejected beacon over 16 KB is split in halves recursively, then falls back to fetch without keepalive | `browser/posthog-core.ts`, `browser/request-queue.ts`, `browser/request.ts` |
| Retries | non-2xx except 4xx: exponential `3000·2^n` capped at 30 min, ±50 % jitter (comment: "6 seconds up to 45 minutes"), honours Retry-After; max **10** retries (**3** for status 0 / network errors); `retry_count` query param; pauses while `navigator.onLine` is false | `browser/retry-queue.ts` |
| Client rate limit | token bucket, **10 events/s**, burst **100** (10×), persisted across reloads; drops events and sends `$$client_ingestion_warning`; `rate_limiting: { events_per_second, events_burst_limit }` | `browser/rate-limiter.ts` |
| Server quota | a `quota_limited: [batchKey]` response pauses that product for 60 s | same |
| Size limits | strings ≤65,535 chars; replay events ≤~0.9 MB (`RECORDING_MAX_EVENT_SIZE`); no general per-batch byte cap found in the queue *(not found in source)* | `browser/posthog-core.ts`, replay recorder |

Links: https://github.com/PostHog/posthog-js/blob/main/packages/browser/src/request.ts · https://github.com/PostHog/posthog-js/blob/main/packages/browser/src/request-queue.ts · https://github.com/PostHog/posthog-js/blob/main/packages/browser/src/retry-queue.ts · https://github.com/PostHog/posthog-js/blob/main/packages/browser/src/rate-limiter.ts · https://github.com/PostHog/posthog-js/blob/main/packages/browser/src/utils/request-router.ts · https://github.com/PostHog/posthog-js/blob/main/packages/browser/src/remote-config.ts

---

## 7. Privacy and consent

- **`opt_out_capturing()` / `opt_in_capturing()`:** writes `__ph_opt_in_out_<token>` = 0/1 (365 days) in the consent store (localStorage by default; cookie if `opt_out_capturing_persistence_type: 'cookie'`). Consent states are PENDING (-1), DENIED (0) and GRANTED (1). PENDING counts as opted out when `opt_out_capturing_by_default: true` or `cookieless_mode: 'on_reject'`. Opting in sends `$opt_in` (name configurable) and starts replay. `opt_out_persistence_by_default` also disables storage while opted out. Source: `browser/consent.ts`, `browser/posthog-core.ts`.
- **`respect_dnt`** (default `false`): reads `navigator.doNotTrack`, `navigator.msDoNotTrack` and `window.doNotTrack`, and treats DNT as opted out. Docs call it "a best-effort signal, not a compliance guarantee". https://posthog.com/docs/libraries/js/config
- **Cookieless mode:**
  - `'always'`: persistence is disabled and `distinct_id = '$posthog_cookieless'` (sentinel), `$device_id: null`, `$cookieless_mode: true`. Session replay is not started (the session manager and recording are skipped) and `$snapshot` is dropped.
  - `'on_reject'`: cookieless until consent; `opt_in_capturing` then does a full `_reset` before normal tracking.
  - Docs (via search): the server builds the ID from a hash of team ID, a **daily salt**, IP, user agent and hostname; the salt is deleted daily; unique users are inflated across days; replay and surveys need consent.
  - Sources: `browser/posthog-core.ts`; https://posthog.com/docs/privacy/cookieless-tracking *(the page body did not render in WebFetch; hash inputs come from the search-result summary of that page and are partly unverified)*.
- **`persistence: 'memory'`** / `disable_persistence: true`: nothing stored, so a new ID on every page load.
- **`property_denylist`** (`[]`): property names deleted from every event. **`sanitize_properties`** is deprecated (logs an error). **`before_send`**: a function, or an array of them, that can edit or return `null` to drop an event; runs after property calculation. Source: `browser/posthog-core.ts`.
- **`mask_personal_data_properties`** (default `false`): replaces the ad click-ID params (and `custom_personal_data_properties`) in URLs with `<masked>`. Source: `common/utils/event-utils.ts`.
- **Input masking:** autocapture never reads input values; replay masks all inputs by default (section 8).
- **IP:** collected server-side from the request; the client `ip` option is a no-op ("Use … 'Discard IP data' project setting").
- **Bot detection:** events are dropped (unless `opt_out_useragent_filter`) if the UA or `userAgentData.brands` contains any of **77** default substrings, or `custom_blocked_useragents`, or `navigator.webdriver` is true. The list includes `bot/`, `crawler`, `headlesschrome`, `cypress`, `googlebot`, `bingbot`, `gptbot`, `chatgpt-user`, `perplexitybot`, `oai-searchbot`, `meta-externalagent`, `bytespider`, `chrome-lighthouse`, `prerender`, `vercelbot`, `uptimerobot`, `slackbot`, `linkedinbot`, `twitterbot`, … `__preview_capture_bot_pageviews` sends bot pageviews as `$bot_pageview`. Sources: https://github.com/PostHog/posthog-js/blob/main/packages/core/src/utils/bot-detection.ts, `common/utils/blocked-uas.ts`
- **Internal users:** `internal_or_test_user_hostname` (localhost from 2026-01-30) calls `setInternalOrTestUser()`.

---

## 8. Session replay basics

- **Engine:** rrweb (PostHog's fork, `@posthog/rrweb`, packaged as `rrweb.js`), in a **lazy-loaded** script, `lazy-recorder.js` (≈67 KB gz served). It loads only if the project has replay on (remote config `sessionRecording.enabled`), `disable_session_recording` is false, the visitor is not opted out, and the mode is not cookieless. Remote config can name another script (`scriptConfig.script`). `.full` bundles include it. Source: https://github.com/PostHog/posthog-js/blob/main/packages/browser/src/extensions/replay/session-recording.ts
- **Default rrweb options:**
  - `blockClass: 'ph-no-capture'` (the element becomes a same-size block)
  - `ignoreClass: 'ph-ignore-input'`
  - `maskTextClass: 'ph-mask'`
  - **`maskAllInputs: true`**, `maskInputOptions: { password: true }` (always)
  - `maskTextSelector` unset, so **page text is not masked**
  - `maskAllElementAttributes: false`
  - `collectFonts: false`, `inlineStylesheet: true` (capped at 10,000 rules), `recordCrossOriginIframes: false`

  Masking can also come from the project's server settings; the client wins and divergence is logged. Source: https://github.com/PostHog/posthog-js/blob/main/packages/browser/src/extensions/replay/external/lazy-loaded-session-recorder.ts; docs: "General text is not masked by default", inputs masked by default. https://posthog.com/docs/session-replay/privacy
- **Network capture** (`config.ts`): off unless enabled by the project or client.
  - Defaults: `recordHeaders: false`, `recordBody: false`, `recordPerformance: false` (performance entry types: first-input, navigation, paint, resource).
  - `payloadSizeLimitBytes` is 1,000,000.
  - `payloadHostDenyList` skips other analytics vendors (Sentry, Clarity, GA, Datadog, Segment, Amplitude, Mixpanel, Hotjar, FullStory, New Relic, LogRocket, RudderStack).
  - **Header deny list:** `authorization`, `cookie`, `set-cookie`, `x-api-key`, `x-forwarded-for`, `x-real-ip`, `forwarded`, `proxy-authorization`, CSRF headers, plus any header containing `auth`, `token`, `secret`, `session`, `api-key`, `credential`, `password`, `cookie`, `csrf` or `xsrf`.
  - **Body deny list:** payloads containing `password`, `secret`, `api_key`, `auth`, `credentials`, `token`, `private_key` … are redacted.
  - `maskRequestFn` lets the site add its own scrubbing.
  - Source: https://github.com/PostHog/posthog-js/blob/main/packages/browser/src/extensions/replay/external/config.ts
- **Console logs:** `enable_recording_console_log` defaults to `undefined`, so the project setting decides (rrweb console plugin, `rrweb-plugin-console-record.js` ≈3 KB gz).
- **Sampling and triggers:** `sampleRate` (client or remote, 0–1), `minimumDurationMilliseconds` (remote; `strictMinimumDuration` from snapshot 2025-11-30), linked feature flag, URL triggers and event triggers, with `triggerMatchType` any/all. Buffered events wait for the triggers.
- **Other numbers:**
  - buffer flush every **2 s** (`RECORDING_BUFFER_TIMEOUT`)
  - idle threshold **5 min** (`RECORDING_IDLE_THRESHOLD_MS`)
  - max event ~0.9 MB
  - canvas capture defaults 4 fps, quality 0.4 (max 12 fps)
  - slow full snapshot threshold 500 ms

  Same source file.

---

## 9. Bundle sizes

Measured 2026-10-18 from npm `posthog-js@1.438.12/dist` (`gzip -9`) and the PostHog CDN (`https://us-assets.i.posthog.com/static/<file>`, served with `Content-Encoding: br`):

| File | Raw | gzip (npm, -9) | Served by CDN (br) |
|---|---|---|---|
| `array.js` (the snippet/CDN bundle; core + autocapture, heatmaps, history, flags, surveys/replay/web-vitals/exception/dead-click *loaders*, toolbar, conversations, logs, metrics, WebMCP) | 334 KB | **105.5 KB** | **106.0 KB** |
| `array.full.js` (everything inlined incl. rrweb, surveys) | 675 KB | 207 KB | — |
| `module.js` (npm ESM default) | 338 KB | 107 KB | — |
| `module.slim.js` (tree-shakeable core; add extensions yourself) | 153 KB | 51.7 KB | — |
| `lazy-recorder.js` / `posthog-recorder.js` (replay) | 215 KB | 66.9 KB | 67.6 KB |
| `surveys.js` | 102 KB | 33.0 KB | 33.3 KB |
| `conversations.js` | 71 KB | 22.3 KB | — |
| `dead-clicks-autocapture.js` | 24 KB | 8.5 KB | 8.8 KB |
| `exception-autocapture.js` | 18 KB | 6.6 KB | 6.8 KB |
| `web-vitals.js` (attribution build 7.1 KB) | 11 KB | 4.0 KB | 4.1 KB |
| `rrweb-plugin-console-record.js` | 8 KB | 3.1 KB | — |

The lazy chunks are fetched from the assets host by `external-scripts-loader` (`loadScript`, versioned paths with `strict_script_versioning: 'fallback'`) and can be blocked with `disable_external_dependency_loading`. The extension list comes from `browser/extensions/extension-bundles.ts` https://github.com/PostHog/posthog-js/blob/main/packages/browser/src/extensions/extension-bundles.ts and `browser/entrypoints/external-scripts-loader.ts`. Sizes are my own measurements (method above), not vendor figures.

For scale: Jun's loader budget is 6 KB gz (D-38). PostHog's default script is about 17× that before replay loads.

---

## Notes and discrepancies

1. **Dead clicks default:** the docs config page says `capture_dead_clicks` defaults to `true`; the code uses the project setting when it is unset (https://posthog.com/docs/libraries/js/config vs `browser/extensions/dead-clicks-autocapture.ts`).
2. **`ph-no-capture` in autocapture:** the autocapture docs page mentions it only for dead clicks, but the code drops any autocapture event whose chain has `ph-no-capture` (or `ph-sensitive`).
3. **Gzip signalling:** the current code removes `compression=gzip-js` from the URL for gzip bodies. How ingestion detects gzip is not shown in client code *(unverified)*.
4. **Cookieless hash inputs** come from a search-engine summary of PostHog's cookieless page, because the page body did not render through the fetch tool *(partly unverified)*.
5. `@posthog/types` source path in the monorepo is inferred from the npm package layout.
