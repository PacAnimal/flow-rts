// A minimal reactive store. Deliberately the same {get, set, update, subscribe} shape
// Svelte's stores use — so code written against it (the Flow editor) can move onto Svelte
// later without touching call sites. subscribe() fires immediately with the current value
// and returns an unsubscribe function. See editor.js and CONTEXT.md.
export function createStore(initial) {
  let value = initial;
  const subs = new Set();
  const notify = () => { for (const fn of subs) fn(value); };
  return {
    get: () => value,
    set(v) { value = v; notify(); },
    update(fn) { value = fn(value) ?? value; notify(); },
    subscribe(fn) { subs.add(fn); fn(value); return () => subs.delete(fn); },
  };
}
