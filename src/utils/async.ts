/**
 * Adapts an async handler for APIs that expect a callback returning void —
 * `addEventListener`, `Menu.onClick`, `window.setTimeout`.
 *
 * Passing an async function directly makes the returned promise float: nothing
 * awaits it, so a rejection becomes an unhandled rejection instead of surfacing
 * anywhere. Wrapping keeps the handler bodies unchanged while making the
 * fire-and-forget explicit.
 */
export const asVoid =
  <A extends unknown[]>(fn: (...args: A) => Promise<unknown>) =>
  (...args: A): void => {
    void fn(...args);
  };
