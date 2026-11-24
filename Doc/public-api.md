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
| `apiVersion` | The API's version, like `'1.0.0'`. See Versions below |
| `extensionVersion` | VectFox's own version from its manifest, like `'3.6.243'`, once VectFox is ready. `null` before that, or when VectFox could not read its manifest (the console says why) |
| `isReady()` | `true` once VectFox has finished starting up |
| `whenReady()` | A promise that resolves when VectFox has finished starting up. It's the same promise every time you ask |
| `capabilities` | The groups of the API this VectFox serves, like `['events']` |
| `on(name, handler)` | Calls your handler every time VectFox sends that event. Returns a function that stops it |
| `off(name, handler)` | Stops calling your handler for that event |

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

When a release raises the major version, VectFox's release notes say so.

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
| `vectfox_llm_call_finished` | `{ feature, connection, profileName, provider, model, durationMs, outcome, usage }` | One of VectFox's own LLM calls ended |

### The EventBase events

EventBase is where VectFox keeps a chat's events, and a chat can have several EventBase collections but uses one at a time. These three events tell you when what you read from it changed.

`chatId` is the ID VectFox keys a chat's collections by, the chat's `chat_metadata.integrity`. In `vectfox_eventbase_synced` and `vectfox_eventbase_events_deleted` it's the chat the collection belongs to, which isn't always the open one: a run started on one chat can end after you opened another. For an archived chat's collection it's the archive's own ID. In `vectfox_eventbase_collection_changed` it's the open chat, and `null` when no chat is open.

`vectfox_eventbase_synced` comes at the end of EVERY run, not just the ones that finish. Say I stop a run after 10 windows: those 10 windows' events are stored, so you hear about them. `eventsAdded` is how many events the run stored, and `windowsProcessed` how many windows it read. A run that read windows but stored nothing still says so, with `eventsAdded: 0`. Auto-sync checking a chat and finding nothing new to read isn't a run, so that says nothing.

`vectfox_eventbase_events_deleted` comes when events go: a window read again replacing its old events, Compact collection, Start over, a delete in the Database Browser, a deleted collection, or an import over one. `eventIds` lists the events removed, or is `null` when the whole collection was emptied. You only hear it in the tab that removed them. A removal that fails part way says nothing, so treat this event as "read again", not as the full list of what's gone.

`vectfox_eventbase_collection_changed` comes when the chat starts using another collection, stops using one, or you open another chat. `collectionId` is `null` when the chat uses none. Think of it like a TV that switched channel: whatever you were following, you're now watching something else, so start following the new one. It never comes for a change that left everything where it was.

### VectFox's own LLM calls

VectFox makes its own LLM calls: EventBase reading the chat, Agent Mode planning a search, StoryArc linking events, LoreBase picking lore. To SillyTavern, a lot of them look just like the story reply. So if you track what a chat costs, `vectfox_llm_call_finished` is how you tell my calls apart. It comes once for every call VectFox sent, Test connection included, and never for one a setting stopped before it left.

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

### How VectFox sends them

VectFox never waits for your handler. It sends the event and moves on, so a slow handler can't slow down a reply. BUT SillyTavern's `eventSource` runs the handlers of one event one after another, and waits for each. So a handler that takes long still holds up the OTHER extensions listening to the same event. Keep your handler short, and start any slow work without returning its promise.

Every payload is frozen, so your handler sees exactly what VectFox sent, whatever another handler does.

If you call `on()` with an event this VectFox doesn't send, maybe a newer one, it subscribes nothing, says so in the console, and still gives you a stop function, which does nothing. A handler that isn't a function throws a `TypeError`, as that's a bug in the calling code.

Basically, check `isReady()`, wait for `vectfox_ready` if you have to, and from there everything goes through the one object.
