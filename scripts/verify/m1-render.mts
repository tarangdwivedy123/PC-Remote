/**
 * Renders the React tree outside a browser.
 *
 * Every other check in this suite inspects HTTP responses and built files, which
 * means a component that throws on its first render — a bad hook call, a
 * malformed className, an undefined destructure — would sail through all of them
 * and only show up as a blank page on the phone. This actually mounts the app.
 *
 * The DOM globals the components touch are stubbed rather than pulled in via
 * jsdom, to avoid adding a dependency for one test.
 */
import { createChecker } from './lib.mjs';

interface StubStore {
  [key: string]: string;
}

function installDomStubs(storage: StubStore): void {
  const listeners = new Map<string, Set<() => void>>();
  const addEventListener = (type: string, fn: () => void): void => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type)?.add(fn);
  };
  const removeEventListener = (type: string, fn: () => void): void => {
    listeners.get(type)?.delete(fn);
  };

  const localStorage = {
    getItem: (key: string) => (key in storage ? storage[key] : null),
    setItem: (key: string, value: string) => {
      storage[key] = value;
    },
    removeItem: (key: string) => {
      delete storage[key];
    },
  };

  const win = {
    localStorage,
    location: { protocol: 'http:', host: '192.168.1.42:8765' },
    addEventListener,
    removeEventListener,
    // uPlot's module-level setup dispatches a synthetic event to prime its
    // device-pixel-ratio tracking.
    dispatchEvent: () => true,
    devicePixelRatio: 2,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
    requestAnimationFrame: (fn: () => void) => globalThis.setTimeout(fn, 0),
    cancelAnimationFrame: (id: number) => globalThis.clearTimeout(id),
  };

  const doc = {
    visibilityState: 'visible',
    // The fullscreen button probes documentElement during its first render.
    documentElement: {},

    addEventListener,
    removeEventListener,
    dispatchEvent: () => true,
    getElementById: () => null,
    // Only reached if something tries to build DOM at import time; React's static
    // renderer never does, and uPlot is only constructed inside an effect.
    createElement: () => ({
      addEventListener,
      removeEventListener,
      appendChild: () => {},
      setAttribute: () => {},
      style: {},
      classList: { add: () => {}, remove: () => {} },
    }),
  };

  Object.assign(globalThis, {
    window: win,
    document: doc,
    localStorage,
    // uPlot reads devicePixelRatio at module load, before any component mounts,
    // so importing the Stats section throws without this.
    devicePixelRatio: 2,
    // uPlot attaches a dppx change listener at import time. Old builds use
    // addListener, newer ones addEventListener, so provide both.
    matchMedia: () => ({
      matches: false,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
    requestAnimationFrame: (fn: () => void) => globalThis.setTimeout(fn, 0),
    cancelAnimationFrame: (id: number) => globalThis.clearTimeout(id),
    WebSocket: class {
      static OPEN = 1;
      readyState = 0;
      close(): void {}
      send(): void {}
    },
  });

  // Node defines `navigator` as a getter-only global, so Object.assign throws on
  // it. A real Android user agent is worth stubbing rather than skipping: it is
  // what getDeviceName() parses to label this phone in the agent's console.
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      userAgent:
        'Mozilla/5.0 (Linux; Android 9; SM-G950F Build/PPR1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/70.0.3538.110 Mobile Safari/537.36',
    },
    configurable: true,
    writable: true,
  });
}

export async function run() {
  const { check, results } = createChecker('Milestone 1 — the app actually renders');

  const storage: StubStore = {};
  installDomStubs(storage);

  // Imported after the stubs are installed: the modules read window/navigator at
  // module scope in a couple of places.
  const { renderToStaticMarkup } = await import('react-dom/server');
  const React = await import('react');

  /**
   * tsx ignores the `jsx` compiler option and always emits the classic
   * `React.createElement` form, which expects React in lexical scope. The real
   * build does not go through tsx — Vite's plugin-react uses the automatic
   * runtime — so rather than fight the resolution, hand the classic transform
   * the global it is looking for. Harmless if the automatic runtime is used,
   * since that imports react/jsx-runtime directly.
   */
  Object.assign(globalThis, { React: React.default ?? React });

  const { App } = await import('../../client/src/App.tsx');

  // -- unpaired: the PIN screen ---------------------------------------------
  let pairHtml = '';
  try {
    pairHtml = renderToStaticMarkup(React.createElement(App));
    check('renders without throwing when no token is stored', true);
  } catch (err) {
    check('renders without throwing when no token is stored', false, String(err));
    return { results };
  }

  check('shows the pairing screen when unpaired', pairHtml.includes('Pairing PIN'), `${pairHtml.length} bytes`);
  check('explains where to find the PIN', /PIN shown in the agent window/.test(pairHtml));
  /**
   * Matched case-insensitively: React 18's static renderer emits the prop name
   * as written (`inputMode`) rather than lowercasing it. That is harmless —
   * HTML attribute names are case-insensitive, and in the live app React sets
   * these through the DOM rather than as markup — so the assertion should not
   * care about the casing.
   *
   * `pattern` is the part that actually matters on old Android: inputMode alone
   * was not honoured by Chrome until later versions, and pattern="[0-9]*" is
   * what reliably brings up the numeric keypad.
   */
  check(
    'the PIN field opens a numeric keypad on old Android',
    /inputmode="numeric"/i.test(pairHtml) && pairHtml.includes('pattern="[0-9]*"'),
  );
  check(
    'the PIN field is type=text, so leading zeros survive',
    /id="pin"[^>]*type="text"/.test(pairHtml) || /type="text"[^>]*id="pin"/.test(pairHtml),
  );
  check('the Pair button starts disabled', /<button[^>]*disabled[^>]*>/.test(pairHtml));
  check('the pairing screen has no unresolved React placeholders', !pairHtml.includes('undefined') && !pairHtml.includes('NaN'));

  // -- paired: the dashboard ------------------------------------------------
  storage['pcr.token'] = 'a-token-long-enough-to-look-real-0123456789';

  let dashHtml = '';
  try {
    dashHtml = renderToStaticMarkup(React.createElement(App));
    check('renders the dashboard without throwing when a token exists', true);
  } catch (err) {
    check('renders the dashboard without throwing when a token exists', false, String(err));
    return { results };
  }

  /**
   * Read the actual <h2> headers rather than searching the whole document for
   * each name. A plain indexOf("System") matches the word inside the Volume
   * section's own description ("System volume plus a slider per app…") and
   * reports the order as wrong when it is not.
   */
  const headers = [...dashHtml.matchAll(/<h2[^>]*>([^<]*)<\/h2>/g)].map((m) => m[1]);
  const expected = ['Now Playing', 'Volume', 'System', 'Stats'];

  for (const section of expected) {
    check(`the "${section}" section is present`, headers.includes(section));
  }
  check(
    'sections appear in the specified top-to-bottom order',
    expected.every((title, i) => headers[i] === title),
    headers.join(' → '),
  );
  check('the connection status is shown', /Connecting|Connected|Idle|Reconnecting/.test(dashHtml));
  check('the dashboard has no unresolved placeholders', !dashHtml.includes('NaN') && !dashHtml.includes('undefined'));

  /**
   * Touch-target floor. Interactive elements must resolve to at least 48px, which
   * in this codebase comes from the `.touch-target` / `.btn` classes rather than
   * inline styles — so this asserts the classes are applied rather than measuring
   * pixels, which static markup cannot show.
   */
  const buttons = dashHtml.match(/<button[^>]*>/g) ?? [];
  const pairButtons = pairHtml.match(/<button[^>]*>/g) ?? [];
  const allButtons = [...buttons, ...pairButtons];
  /**
   * A button must declare its own height. `min-h-[NNpx]` counts when NN clears
   * the 48px touch-target floor, which is how the newer sections size theirs.
   */
  const untouched = allButtons.filter((b) => {
    if (/class="[^"]*(btn|touch-target|h-8)[^"]*"/.test(b)) return false;
    if (/class="[^"]*\bh-1[2-9]\b[^"]*"/.test(b)) return false;
    const minH = /min-h-\[(\d+)px\]/.exec(b);
    return !(minH && Number(minH[1]) >= 48);
  });
  check(
    'every button carries a sized class, not a bare default',
    untouched.length === 0,
    untouched.join(' ') || `${allButtons.length} buttons checked`,
  );

  return { results };
}
