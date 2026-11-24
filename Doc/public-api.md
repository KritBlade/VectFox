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

VectFox never waits for your handler. It sends the event and moves on, so a slow handler can't slow down a reply. BUT SillyTavern's `eventSource` runs the handlers of one event one after another, and waits for each. So a handler that takes long still holds up the OTHER extensions listening to the same event. Keep your handler short, and start any slow work without returning its promise.

Every payload is frozen, so your handler sees exactly what VectFox sent, whatever another handler does.

If you call `on()` with an event this VectFox doesn't send, maybe a newer one, it subscribes nothing, says so in the console, and still gives you a stop function, which does nothing. A handler that isn't a function throws a `TypeError`, as that's a bug in the calling code.

Basically, check `isReady()`, wait for `vectfox_ready` if you have to, and from there everything goes through the one object.
