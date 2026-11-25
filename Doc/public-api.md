# VectFox for extension developers

This page is for you if you write a SillyTavern extension and want it to work with VectFox. VectFox gives you one object, `globalThis.VectFox`, and its own events. You use those, and you never have to fork VectFox or import its files.

Why not just import the files? Because files move. When I reorganize VectFox, an extension that imports one of its files by path breaks on that update. So does one that expects VectFox's folder to be called `VectFox`. The object stays at the same name no matter where the files go, and no matter which folder VectFox is installed in.

## Getting the object

VectFox puts the object on `globalThis.VectFox` as soon as its code loads, which is BEFORE it finishes starting up. So the object can be there and not ready yet.

Think of a shop that unlocks the door at 8:55 but opens the till at 9:00. You can walk in, but you can't pay yet. `isReady()` tells you whether the till is open.

Your extension may load before VectFox, or after it. This one piece of code covers both:

```js
const { eventSource } = SillyTavern.getContext();

function startWithVectFox(VectFox) {
    console.log(`VectFox ${VectFox.extensionVersion}, API ${VectFox.apiVersion}`);
}

if (globalThis.VectFox?.isReady()) {
    startWithVectFox(globalThis.VectFox);
} else {
    eventSource.on('vectfox_ready', () => startWithVectFox(globalThis.VectFox));
}
```

If VectFox is already ready, you start right away. If not, because it hasn't loaded yet or is still starting up, you wait for `vectfox_ready`, which VectFox sends once. You listen on SillyTavern's own `eventSource` here, because the VectFox object may not exist yet.

Once you have the object, `await VectFox.whenReady()` does the same wait as a promise.

### What's on it

| Name | What it gives you |
|---|---|
| `apiVersion` | The API's version, like `'1.4.0'`. See Versions below |
| `extensionVersion` | VectFox's own version from its manifest, like `'3.6.245'`, once VectFox is ready. `null` before that, or when VectFox could not read its manifest (the console says why) |
| `isReady()` | `true` once VectFox has finished starting up |
| `whenReady()` | A promise that resolves when VectFox has finished starting up. It's the same promise every time you ask |
| `capabilities` | The groups of the API this VectFox serves, like `['events', 'chat', 'settings', 'eventbase.read', 'chat.messageSource']` |
| `on(name, handler)` | Calls your handler every time VectFox sends that event. Returns a function that stops it |
| `off(name, handler)` | Stops calling your handler for that event |
| `chat` | The open chat: `chat.getChatId()` and `chat.getCollectionInUse()`, see The chat, its collection and the settings below. And `chat.registerMessageSource()`, for a summarizer, see Message sources below |
| `getSettingsSnapshot()` | A frozen copy of the settings that decide what VectFox does to the prompt, and whether it marks its LLM requests. Also below |
| `eventBase` | The events VectFox reads out of a chat: `eventBase.listEvents()`. See Reading EventBase below |

The object is frozen, so you can't change it or add to it.

If VectFox fails to start, `isReady()` stays `false` and `whenReady()` never resolves. So don't hold up your own extension waiting for it.

### Capabilities

Each group of the API puts its name in `capabilities` when it ships. Check the name once, instead of checking every method you want to call:

```js
if (VectFox.capabilities.includes('events')) {
    VectFox.on('vectfox_ready', () => console.log('VectFox is ready'));
}
```

## Versions

`apiVersion` follows semver, and the rule is simple:
- A new minor version, 1.0 to 1.1, only ADDS things: a method, an event, a field, a reason. Nothing you use is removed, renamed or changed. So an extension written for 1.0 works with any 1.x.
- A new major version, 1.x to 2.0, means something was removed, renamed or changed. The old name is gone right away. No code keeps it working on the side.

So compare the major version only:

```js
const [major] = VectFox.apiVersion.split('.').map(Number);
if (major !== 1) {
    console.warn(`My extension was written for VectFox API 1, and this VectFox has API ${VectFox.apiVersion}`);
}
```

EventBase's events have a version of their own, `schemaVersion`, which every `listEvents` answer carries, like `'1.3'`. It follows the exact same rule, so you compare its major only too. A new field on an event is a new minor version, and nothing you read changes.

When a release raises the major version, VectFox's release notes say so.

## When a call says no

A call to VectFox never throws for something that can just happen, like no chat being open. It answers you. `{ ok: true, ... }` when it has what you asked for, `{ ok: false, reason }` when it doesn't, and `reason` says why.

Think of calling a shop. "Sold out" and "we're closed" are normal answers, not a fire alarm. You hear which one it is, and you carry on.

| `reason` | What it means |
|---|---|
| `'not-ready'` | VectFox hasn't finished starting up. Every call says this until `vectfox_ready`, so wait for it and ask again |
| `'no-chat'` | No chat is open. From `listEvents`, it can also mean the chat you named isn't the open one |
| `'no-collection'` | A chat is open, but it uses no EventBase collection. From `listEvents`, it can also mean the collection you named isn't the chat's you named |
| `'backend-unsupported'` | The chat's events live somewhere with no change numbers, so there's no feed to read. See Reading EventBase |
| `'read-failed'` | The read didn't get through, like Qdrant being down or SillyTavern having just restarted. The console says why. Ask again in a bit |

```js
const answer = VectFox.chat.getChatId();
if (answer.ok) {
    console.log(`The open chat is ${answer.chatId}`);
} else if (answer.reason === 'no-chat') {
    console.log('No chat is open');
}
```

Every answer is frozen, same as the events. A new minor version can add a reason, so treat one you don't know as a plain no.

## Events

VectFox sends its events on SillyTavern's `eventSource`, and every name starts with `vectfox_`. You listen with `VectFox.on(name, handler)`, or with `eventSource.on(name, handler)` when the VectFox object doesn't exist yet.

```js
const stop = VectFox.on('vectfox_ready', ({ apiVersion }) => {
    console.log(`VectFox is ready, API ${apiVersion}`);
});
// Later, when you no longer want it:
stop();
```

| Event | Payload | When |
|---|---|---|
| `vectfox_ready` | `{ apiVersion }` | Once, when VectFox has finished starting up |
| `vectfox_eventbase_synced` | `{ chatId, collectionId, eventsAdded, windowsProcessed }` | Every time an EventBase run ends, finished, stopped or failed |
| `vectfox_eventbase_events_deleted` | `{ chatId, collectionId, eventIds }` | Events were removed from an EventBase collection in this tab |
| `vectfox_eventbase_collection_changed` | `{ chatId, collectionId }` | The collection the open chat uses changed, or another chat opened |
| `vectfox_llm_call_finished` | `{ feature, connection, profileName, provider, model, durationMs, outcome, usage }` | One of VectFox's own LLM calls ended. See VectFox's own LLM calls below |

### The EventBase events

EventBase is where VectFox keeps a chat's events, and a chat can have several EventBase collections but uses one at a time. These three events tell you when what you read from it changed.

`chatId` is the ID VectFox keys a chat's collections by, the chat's `chat_metadata.integrity`. In `vectfox_eventbase_synced` and `vectfox_eventbase_events_deleted` it's the chat the collection belongs to, which isn't always the open one: a run started on one chat can end after you opened another. For an archived chat's collection it's the archive's own ID. In `vectfox_eventbase_collection_changed` it's the open chat, and `null` when no chat is open.

`vectfox_eventbase_synced` comes at the end of EVERY run, not just the ones that finish. Say I stop a run after 10 windows: those 10 windows' events are stored, so you hear about them. `eventsAdded` is how many events the run stored, and `windowsProcessed` how many windows it read. A run that read windows but stored nothing still says so, with `eventsAdded: 0`. Auto-sync checking a chat and finding nothing new to read isn't a run, so that says nothing.

When you hear it, read the feed from your cursor (Reading EventBase below). That gives you exactly what the run changed, and a read with nothing new answers fast with an empty page.

`vectfox_eventbase_events_deleted` comes when events go: a window read again replacing its old events, Compact collection, Start over, a delete in the Database Browser, a deleted collection, or an import over one. `eventIds` lists the events removed, or is `null` when the whole collection was emptied. You only hear it in the tab that removed them. A removal that fails part way says nothing, so treat this event as "read again", not as the full list of what's gone.

`vectfox_eventbase_collection_changed` comes when the chat starts using another collection, stops using one, or you open another chat. `collectionId` is `null` when the chat uses none. Think of it like a TV that switched channel: whatever you were following, you're now watching something else, so start following the new one. It never comes for a change that left everything where it was.

### How VectFox sends them

VectFox never waits for your handler. It sends the event and moves on, so a slow handler can't slow down a reply. BUT SillyTavern's `eventSource` runs the handlers of one event one after another, and waits for each. So a handler that takes long still holds up the OTHER extensions listening to the same event. Keep your handler short, and start any slow work without returning its promise.

Every payload is frozen, so your handler sees exactly what VectFox sent, whatever another handler does.

If you call `on()` with an event this VectFox doesn't send, maybe a newer one, it subscribes nothing, says so in the console, and still gives you a stop function, which does nothing. A handler that isn't a function throws a `TypeError`, as that's a bug in the calling code.

## The chat, its collection and the settings

These calls tell you what VectFox sees right now. `capabilities` has `'chat'` and `'settings'` when this VectFox has them.

### Which chat, and which collection

`chat.getChatId()` answers `{ ok: true, chatId }`. That's the ID VectFox keys the open chat's EventBase collections by, the chat's `chat_metadata.integrity`, and the same `chatId` the events carry. With no chat open, the answer is `'no-chat'`.

`chat.getCollectionInUse()` answers `{ ok: true, collectionId }`, the EventBase collection the open chat uses. A chat can have several, but it uses ONE at a time, and VectFox's own reads ask the exact same question. So your answer is always the collection VectFox itself reads and writes. With no chat open it says `'no-chat'`, and with a chat that uses no collection, `'no-collection'`.

Both answer for the moment you ask. You don't have to ask in a loop: `vectfox_eventbase_collection_changed` tells you when the answer changes.

```js
VectFox.on('vectfox_eventbase_collection_changed', () => {
    const answer = VectFox.chat.getCollectionInUse();
    console.log(answer.ok ? `Now reading ${answer.collectionId}` : `No collection: ${answer.reason}`);
});
```

### The settings snapshot

`getSettingsSnapshot()` answers `{ ok: true, settings }`. It's a frozen copy of the settings that decide what VectFox does to the prompt, how often it reads the chat, and whether it marks its LLM requests.

It's a copy of the moment you ask, and the user can change a setting any time. So ask again for every request instead of keeping one. It's like checking the weather in the morning instead of trusting last week's forecast.

| Setting | What it is |
|---|---|
| `enabled` | VectFox's own on/off switch. Off, VectFox adds nothing to the prompt, blanks nothing and doesn't auto-sync |
| `ghostingEnabled` | Ghosting: VectFox blanks old messages it has already read into events from the prompt it sends, as the events stand in for them. It only acts while `summarizerInjectionEnabled` is on too |
| `ghostingKeepRecent` | How many of the latest messages ghosting always keeps |
| `ghostingBatchSize` | How many messages the blanking moves by at a time. Above 1, the start of the prompt stays the same for a while, which keeps a provider's prompt cache working |
| `summarizerInjectionEnabled` | Summarizer Injection: VectFox sends the most recent events every turn |
| `summarizerInjectionCount` | How many of the most recent events it sends |
| `summarizerInjectionFullDetail` | `true` sends each event with its details, `false` its summary only |
| `summarizerInjectionMaxChars` | The most characters that block may take, `0` for no limit |
| `autoSyncWindowTurns` | How many turns auto-sync reads at a time. While Summarizer Injection is on, it's held at 1 |
| `autoSyncSettleLag` | `true` when auto-sync waits for a turn to stop being swipeable before it reads it |
| `requestMarkEnabled` | `true` when VectFox puts its mark on its LLM requests (see VectFox's own LLM calls). It's the user's switch, so you can read it, but nothing in the API changes it |

```js
const answer = VectFox.getSettingsSnapshot();
if (answer.ok && answer.settings.enabled && answer.settings.ghostingEnabled && answer.settings.summarizerInjectionEnabled) {
    console.log(`VectFox keeps the latest ${answer.settings.ghostingKeepRecent} messages and blanks the rest it has read`);
}
```

A setting keeps its name here even when I rename it inside VectFox, so you never have to read `extension_settings.vectfox` yourself. There's no key and no key ID in it, ever.

Auto-sync itself is switched on and off per collection, so it's not in the snapshot.

## Reading EventBase

`eventBase.listEvents()` gives you the events VectFox read out of a chat. The first time you ask, you get all of them. After that, you only ask for what changed since your last read: the events stored or edited, and the ones removed. `capabilities` has `'eventbase.read'` when this VectFox has it.

### Change numbers, not chat positions

Every time VectFox stores, edits or removes an event, the server gives that change the next number. That number is the `cursor`. You keep the last `cursor` you read, and next time you ask for everything after it.

Think of your bank. It doesn't send you your whole history every morning. Every payment gets the next number, and your next statement starts right after the last one. So nothing slips between two statements, no matter how many payments came in.

So why not just ask for "everything after message 500"? Because chat positions move. A summarizer swaps 50 messages for one summary, and message 500 is now message 451. A reader that follows positions sees the next events at 451, thinks it already has them... and skips them for good. A change number never moves, whatever happens to the chat.

```js
const kept = new Map();   // eventId -> event
let cursor;               // undefined until the first read

async function catchUp() {
    let answer;
    do {
        answer = await VectFox.eventBase.listEvents({ after: cursor });
        if (!answer.ok) return console.log(`Nothing read: ${answer.reason}`);
        if (answer.emptied) kept.clear();
        for (const eventId of answer.removedEventIds) kept.delete(eventId);
        for (const event of answer.events) kept.set(event.eventId, event);
        cursor = answer.cursor;
    } while (answer.hasMore);
    console.log(`${kept.size} events, read up to ${cursor}`);
}
```

That's the whole loop: drop what was emptied or removed, keep what came in, and remember where you stopped. With no `after`, it reads the collection the open chat uses.

### What you get back

`listEvents` is async, so `await` it. It answers `{ ok: true, ... }` with these, or `{ ok: false, reason }` like every other call.

| Field | What it is |
|---|---|
| `schemaVersion` | The version of EventBase's events, like `'1.3'`. See Versions above |
| `collectionId` | The collection this answer read |
| `events` | The events stored or edited since `after`, oldest change first. With no `after`, every event the collection holds |
| `removedEventIds` | The `eventId` of each event removed since `after` |
| `emptied` | `true` when the whole collection was emptied since `after`. Throw away what you kept from it first, then take `events` |
| `cursor` | Where this answer stopped. Pass it as `after` next time |
| `hasMore` | `true` when there's more to read. Ask again right away, from the new `cursor` |

One answer holds up to 100 changes, which is what `hasMore` is for. A full read, with no `after`, always comes in one answer.

### Each event

| Field | What it is |
|---|---|
| `eventId` | The event's ID. It never changes, so keep events by it |
| `summary` | One line on what happened |
| `cause` | What led to it, `''` when the event has none |
| `result` | What came out of it, `''` when none |
| `characters` | Who was in it |
| `locations` | Where it happened |
| `importance` | How much it matters to the story, from 1 to 10 |
| `storyTime` | When it happened in the story, as an ISO date and time, `null` when the story gave no date |
| `sceneTime` | The same moment in the story's own words, like `'the third night of the harvest festival'`, `''` when none |
| `windowStart` / `windowEnd` | The first and last chat message VectFox read it from, by message number in story order: the messages with text, counted from 0, and a summary a message source answers for counted as the messages it stands for (see Message sources below) |
| `cursor` | The change number it was stored or last edited under, `0` when it was stored before change numbers existed |

Everything in an answer is frozen.

### An event can come again

An edit gives an event a new number. So an event you already have can show up again with a higher `cursor`: StoryArc linking it to another event, or the user fixing it in the Database Browser. Some edits change a field you don't get, so it can look exactly the same. That's why you keep events by `eventId` and just replace your copy.

### Start with a full read

Events VectFox stored before change numbers existed have `cursor` `0`. Only a full read, with no `after`, gives you those. `after: 0` skips them. So your first read of a collection is always without `after`.

### Removed and emptied

`removedEventIds` comes from a window read again replacing its old events, Compact collection merging events, or a delete in the Database Browser. Drop each of them.

`emptied` comes from Start over, a deleted collection, or an import over one. You throw away everything you kept from that collection, then take `events`, which is only what came after.

### One cursor per collection

A chat can have several EventBase collections, and uses one at a time. The numbers belong to a collection, so keep one cursor per collection. When `vectfox_eventbase_collection_changed` says the chat moved to another collection, read that one from ITS cursor, or with a full read when you never read it.

```js
const collections = {};   // collectionId -> { cursor, events }

async function catchUpWith(collectionId) {
    const kept = (collections[collectionId] ??= { cursor: undefined, events: new Map() });
    let answer;
    do {
        answer = await VectFox.eventBase.listEvents({ collectionId, after: kept.cursor });
        if (!answer.ok) return console.log(`Nothing read from ${collectionId}: ${answer.reason}`);
        if (answer.emptied) kept.events.clear();
        for (const eventId of answer.removedEventIds) kept.events.delete(eventId);
        for (const event of answer.events) kept.events.set(event.eventId, event);
        kept.cursor = answer.cursor;
    } while (answer.hasMore);
}

const inUse = VectFox.chat.getCollectionInUse();
if (inUse.ok) catchUpWith(inUse.collectionId);
VectFox.on('vectfox_eventbase_collection_changed', ({ collectionId }) => { if (collectionId) catchUpWith(collectionId); });
VectFox.on('vectfox_eventbase_synced', ({ collectionId }) => { catchUpWith(collectionId); });
VectFox.on('vectfox_eventbase_events_deleted', ({ collectionId }) => { catchUpWith(collectionId); });
```

The handlers start the read and don't return it, so they never hold up the other extensions listening.

### Another tab, another device

The numbers live on the server, in the Similharity plugin, not in your page. So a reader in another tab, or on your phone, catches up the exact same way: it remembers its cursor and asks for what came after.

The events only come in the tab that did the work. So treat `vectfox_eventbase_synced` and `vectfox_eventbase_events_deleted` as a nudge to read now, and the feed as the full story.

### Which collection it reads

- No `collectionId`: the collection the open chat uses, the same one `chat.getCollectionInUse()` gives. With no chat open you get `'no-chat'`, and with none in use `'no-collection'`.
- `collectionId`: that collection, from any chat, even with no chat open. Use the IDs VectFox gives you, from `chat.getCollectionInUse()` or an event's payload.
- `chatId`: the chat the read is about, a safety check for when the user switches chats between your decision and your call. Without `collectionId`, that chat has to be the open one, or you get `'no-chat'`. With `collectionId`, the collection has to be that chat's, or you get `'no-collection'`.

### When it says no

`'backend-unsupported'` means the chat's events live where there are no change numbers. That's the Standard backend, SillyTavern's own vector store, or the Qdrant backend with a Similharity plugin older than 3.4.19, or a Qdrant older than 1.8. Nothing changes that until the user moves to Qdrant or updates.

`'read-failed'` means the read didn't get through, like Qdrant being down, or SillyTavern having just restarted. The console says why, and asking again in a bit usually works.

`listEvents` only rejects for a call that can't be right, with a `TypeError`: a request that isn't an object, a `collectionId` that isn't an EventBase collection's ID, a `chatId` that isn't a chat's ID, or an `after` that isn't a whole number of 0 or more.

## Message sources

A summarizer swaps a stretch of messages for one summary. A message source tells VectFox which messages that summary stands for, so VectFox keeps reading the chat as the story it was. `capabilities` has `'chat.messageSource'` when this VectFox has it.

Why does VectFox care? Because EventBase numbers the messages it reads. Say EventBase has read messages 0 to 99, and a summarizer swaps messages 0 to 49 for one summary. Without a source, VectFox now sees 51 messages where it read 100. It takes the summary for a new message, and reads the same story out of it a second time.

Think of a book where someone tore out pages 30 to 211 and put a one-page recap in their place. Your notes say "page 212", but that page is now page 31. A message source is the sticky note on the recap that says "this stands for pages 30 to 211", so every note still lands on the right page.

### Registering one

`chat.registerMessageSource({ owner, originalsOf })` registers your function, and gives you back a function that unregisters it. `owner` names your extension, and the console uses that name if your function ever fails. You can register any time, before VectFox is ready too, and it counts from VectFox's next read.

```js
const stop = VectFox.chat.registerMessageSource({
    owner: 'Hearth Summaries',
    originalsOf: (message) => message.extra?.hearth?.replaced ?? null,
});
// Later, when your extension turns off:
stop();
```

A call that can't be right throws a `TypeError`: no object, an `owner` that isn't a name, or an `originalsOf` that isn't a function.

### What originalsOf answers

VectFox calls `originalsOf(message, { chatMetadata })` for every message it reads. `chatMetadata` is the chat's `chat_metadata` as it is right now. Your function answers one of 3 things:

| Answer | What VectFox does |
|---|---|
| `null` | It's an ordinary message, so VectFox reads it as itself |
| A list of messages | It's a summary of those. VectFox reads them in its place, in that order, and asks you about each of them too, so a summary inside a summary works |
| `[]` | It's a summary of messages still in the chat, or of nothing. VectFox skips it |

Use `[]` when your summarizer hides the old messages and adds a summary. The hidden messages are still in the chat and VectFox reads them anyway, so reading them through the summary would read them twice.

The messages in your list are message objects like the chat's, with `name`, `is_user` and `mes`. VectFox reads them exactly the way it reads the chat's.

### The rules

Your function runs every single time VectFox reads the chat, once per message. So keep it to 3 rules:
- Answer at once, no promise and no `await`.
- Give the same answer for the same message every time.
- Change nothing you're handed, not the message and not `chatMetadata`.

If your function throws, or answers anything but `null` or a list of messages, VectFox reads that message as an ordinary one and says so in the console, once.

With several sources registered, VectFox asks them in the order they registered, and the first one that answers with a list decides. A source that throws counts as `null`, so the next one still gets asked.

VectFox opens summaries 64 levels deep. A summary deeper than that, or one whose list holds a summary it sits inside, is read as itself, and the console says so.

### What VectFox does with it

Everything that reads the chat into EventBase reads it in story order, each summary as its messages: auto-sync, Vectorize Content, a branch's copied events, and the message counts on VectFox's pages. So the message numbers stay put. Summarize 50 messages, and message 500 is still message 500 to EventBase. Restore them, and nothing moves either. `windowStart` and `windowEnd` count the same way.

The search text, LoreBase's scene and Agent Mode's planner read the chat as the model does, the summary as itself. That's what the model is about to read, so that's what they search with.

Ghosting never blanks a summary. It takes the messages EventBase has read out of the prompt on both sides of it, and the summary stays where it is. So beside a summarizer whose summaries open the chat, the model gets the summaries first, then the latest messages, and VectFox's memory covers the read messages in between.

A chat that was summarized and read into EventBase BEFORE your source registered was read from the summary's text. Read it again once, from its first message, and from then on it's right.

### A worked example: InlineSummary

[`tools/public-api-sample/message-source.js`](../tools/public-api-sample/message-source.js) is a message source for InlineSummary. InlineSummary swaps a range of messages for one summary and keeps the originals in one of 3 places, and the sample reads all 3:
- On the summary itself, `ILS_Data.OriginalMessages`, since InlineSummary 1.2.0.
- In the summary's `extra`, before 1.2.0.
- In brasen56's fork, in `chat_metadata.ILS_Originals`, under the `Ref` the summary holds.

```js
export function inlineSummaryOriginals(message, { chatMetadata }) {
    const data = message.ILS_Data ?? message.extra?.ILS_Data;
    if (!data) return null;                                 // an ordinary message
    if (Array.isArray(data.OriginalMessages)) return data.OriginalMessages;
    const kept = chatMetadata?.ILS_Originals?.[data.Ref];   // brasen56's fork keeps them here
    return Array.isArray(kept) ? kept : null;               // originals gone: read the summary as it is
}
```

When the originals are gone, like after a fork's Flatten deleted them, it answers `null`, and VectFox reads the summary as it is.

`registerInlineSummarySource()` in the same file registers it, right away when VectFox's object is there, or on `vectfox_ready` when VectFox loads after it. Put it in InlineSummary itself, in a fork of it, or in a small extension of your own that runs beside it. As its own extension it keeps working even while InlineSummary is off, so a summarized chat still reads right.

## VectFox's own LLM calls

VectFox makes its own LLM calls: EventBase reading the chat, Agent Mode planning a search, StoryArc linking events, LoreBase picking lore. To SillyTavern, a lot of them look just like the story reply. So if you track what a chat costs, you need to tell my calls apart, and VectFox gives you 2 ways: an event after every call, and a mark on each call's request once the user switches it on.

### The event after every call

`vectfox_llm_call_finished` comes once for every call VectFox sent, Test connection included, and never for one a setting stopped before it left.

| Field | What it is |
|---|---|
| `feature` | Who made the call: `'eventbase'`, `'lorebase'`, `'storyarc'` or `'agent'` |
| `connection` | `'profile'`, a SillyTavern connection profile, or `'manual'`, a provider set in VectFox itself |
| `profileName` | The profile's name, `null` on a manual connection |
| `provider` | The provider, like `'openrouter'` or `'custom'` |
| `model` | The model, `null` when none is named |
| `durationMs` | From sending the request to its end, in milliseconds |
| `outcome` | `'ok'` for a reply with text, `'timed-out'` when its time limit passed first, `'failed'` for anything else |
| `usage` | `{ promptTokens, completionTokens, totalTokens, cachedTokens }`, only when the reply reported its tokens. A reply that came back with no text can still carry them, since those tokens were spent |

There's no key and no key ID in it, ever.

```js
VectFox.on('vectfox_llm_call_finished', ({ feature, model, usage }) => {
    if (usage) console.log(`VectFox ${feature} on ${model}: ${usage.totalTokens} tokens`);
});
```

### The mark on VectFox's requests

The event comes AFTER the call. If your tracker watches `fetch`, you want to know whose request it is while it's going out. That's what the mark is for.

Think of the envelopes a company mails out. Each one has the company's stamp in the corner, so the post office knows who sent it without opening it. The mark is that stamp, and it never changes what's inside the envelope.

The mark is OFF until the user turns it on. It's on VectFox's PublicAPI page, under Development: **Mark VectFox's LLM requests**. Most people never run a tracker, so VectFox leaves their requests alone. If your tracker reads the mark, tell your users to switch it on. It counts from the next call.

Your tracker can read that switch, but not flip it. `getSettingsSnapshot()` gives it as `requestMarkEnabled`, and if it's `false`, ask the user to turn it on. Nothing in the API changes it, so please don't reach into VectFox's settings to do it either.

VectFox puts the mark on the request's signal, the AbortSignal in the `init` that `fetch` gets. It's under `Symbol.for('vectfox.internal-request')`, and the value is `{ label: 'VectFox storyarc' }`: `VectFox`, then the call's `feature`, the same name the event gives. It's frozen and not enumerable, and the request's body and headers are exactly what they would be without it.

It works the same on every connection. Sometimes VectFox calls `fetch` itself. On a SillyTavern connection profile (`connection: 'profile'`), SillyTavern builds the request and calls `fetch`, and it passes along the signal VectFox handed it, as is. Either way the mark goes out with the request.

```js
const VECTFOX_MARK = Symbol.for('vectfox.internal-request');
const originalFetch = window.fetch;
window.fetch = function (input, init) {
    const mark = init?.signal?.[VECTFOX_MARK];
    if (mark) console.log(`${mark.label} is calling a model`);
    return originalFetch.apply(this, arguments);
};
```

Read it right off `init.signal`, the signal you're handed. A new signal made from it, like `AbortSignal.any([init.signal])`, doesn't carry it.

The mark tells you whose request is going out, and the event is the full record. With the switch off, or if a SillyTavern update ever stops passing the signal along as is, a request goes out with no mark, but the event still reports the call. So a tracker uses both: the mark to file each request as it goes out, and the event to make sure nothing slipped by.

Basically, check `isReady()`, wait for `vectfox_ready` if you have to, and from there everything goes through the one object. The mark is the only thing outside it: your users switch it on, and you read it right off the request's signal.
