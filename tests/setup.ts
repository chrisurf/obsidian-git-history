/**
 * Installs the DOM helpers Obsidian adds to Element.prototype (createDiv,
 * setText, addClass, …) and replaces requestAnimationFrame with a queue the
 * tests can flush deterministically.
 *
 * Runs for every suite, including the ones using the node environment, so the
 * DOM half is skipped when there is no document.
 */

interface DomElementInfo {
  cls?: string | string[];
  text?: string;
  attr?: Record<string, string | number | boolean | null>;
  type?: string;
  placeholder?: string;
  value?: string;
  title?: string;
  href?: string;
}

const globals = globalThis as unknown as Record<string, unknown>;

// --- Deterministic animation frames -----------------------------------------

let nextHandle = 1;
const frames = new Map<number, FrameRequestCallback>();

globals.requestAnimationFrame = (cb: FrameRequestCallback): number => {
  const handle = nextHandle++;
  frames.set(handle, cb);
  return handle;
};
globals.cancelAnimationFrame = (handle: number): void => {
  frames.delete(handle);
};

/** Runs every queued frame callback. Returns how many ran. */
export function flushFrames(): number {
  let ran = 0;
  // A frame may schedule another; bound the cascade so a bug cannot hang CI.
  for (let pass = 0; pass < 10 && frames.size > 0; pass++) {
    const pending = [...frames.values()];
    frames.clear();
    for (const cb of pending) {
      cb(pass);
      ran++;
    }
  }
  return ran;
}

/** Number of frames currently queued — used to assert scroll coalescing. */
export function pendingFrames(): number {
  return frames.size;
}

// --- Obsidian's Element extensions ------------------------------------------

function applyInfo(el: HTMLElement, info?: string | DomElementInfo): void {
  if (info === undefined) return;
  if (typeof info === "string") {
    if (info) el.className = info;
    return;
  }
  if (info.cls) el.className = Array.isArray(info.cls) ? info.cls.join(" ") : info.cls;
  if (info.text !== undefined) el.textContent = info.text;
  if (info.attr) {
    for (const [key, value] of Object.entries(info.attr)) {
      if (value !== null && value !== undefined) el.setAttribute(key, String(value));
    }
  }
  if (info.type) el.setAttribute("type", info.type);
  if (info.placeholder) el.setAttribute("placeholder", info.placeholder);
  if (info.value !== undefined) (el as HTMLInputElement).value = info.value;
  if (info.title) el.setAttribute("title", info.title);
  if (info.href) el.setAttribute("href", info.href);
}

function makeEl(tag: string, info?: string | DomElementInfo, parent?: Element): HTMLElement {
  const el = document.createElement(tag);
  applyInfo(el, info);
  if (parent) parent.appendChild(el);
  return el;
}

function makeSvg(tag: string, info?: string | DomElementInfo, parent?: Element): SVGElement {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  applyInfo(el as unknown as HTMLElement, info);
  if (parent) parent.appendChild(el);
  return el;
}

function installDomHelpers(): void {
  // Obsidian puts these on Element so they work for SVG nodes too.
  const proto = Element.prototype as unknown as Record<string, unknown>;

  proto.createEl = function (this: Element, tag: string, info?: string | DomElementInfo) {
    return makeEl(tag, info, this);
  };
  proto.createDiv = function (this: Element, info?: string | DomElementInfo) {
    return makeEl("div", info, this);
  };
  proto.createSpan = function (this: Element, info?: string | DomElementInfo) {
    return makeEl("span", info, this);
  };
  proto.setText = function (this: Element, text: string) {
    this.textContent = text;
    return this;
  };
  proto.appendText = function (this: Element, text: string) {
    this.appendChild(document.createTextNode(text));
  };
  proto.empty = function (this: Element) {
    while (this.firstChild) this.removeChild(this.firstChild);
  };
  proto.detach = function (this: Element) {
    this.remove();
  };
  proto.addClass = function (this: Element, ...classes: string[]) {
    this.classList.add(...classes.filter(Boolean));
  };
  proto.removeClass = function (this: Element, ...classes: string[]) {
    this.classList.remove(...classes.filter(Boolean));
  };
  proto.setCssStyles = function (this: HTMLElement, styles: Record<string, string>) {
    Object.assign(this.style, styles);
  };
  proto.setCssProps = function (this: HTMLElement, props: Record<string, string>) {
    for (const [name, value] of Object.entries(props)) this.style.setProperty(name, value);
  };
  proto.toggleClass = function (this: Element, classes: string | string[], value: boolean) {
    for (const cls of Array.isArray(classes) ? classes : [classes]) {
      this.classList.toggle(cls, value);
    }
  };

  // Obsidian's SVG counterparts, used by the graph's lane rendering.
  proto.createSvg = function (this: Element, tag: string, info?: string | DomElementInfo) {
    return makeSvg(tag, info, this);
  };

  globals.createEl = (tag: string, info?: string | DomElementInfo) => makeEl(tag, info);
  globals.createSvg = (tag: string, info?: string | DomElementInfo) => makeSvg(tag, info);
  globals.createDiv = (info?: string | DomElementInfo) => makeEl("div", info);
  globals.createSpan = (info?: string | DomElementInfo) => makeEl("span", info);
  globals.activeDocument = document;
}

if (typeof Element !== "undefined") installDomHelpers();
