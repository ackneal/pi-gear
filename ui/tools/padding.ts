import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component } from "@earendil-works/pi-tui";

let outputPad = 1;
const padded = new WeakSet<Component>();

export function configureOutputPadding(pi: Pick<ExtensionAPI, "getSettings">): void {
  // Old transcript components can still render after the extension API expires.
  outputPad = pi.getSettings().outputPad === 0 ? 0 : 1;
}

/** Keep the native component identity/type available to lastComponent consumers. */
export function padOutput<T extends Component>(component: T): T {
  if (padded.has(component)) return component;
  padded.add(component);
  const render = component.render.bind(component);
  component.render = (width) => {
    const available = Math.max(0, Math.floor(width));
    const pad = Math.min(outputPad, Math.max(0, Math.floor((available - 1) / 2)));
    const inner = Math.max(1, available - pad * 2);
    return render(inner).map((line) => truncateToWidth(" ".repeat(pad) + line, Math.max(0, available - pad), ""));
  };
  return component;
}

export function paddedRenderer<A extends unknown[], T extends Component>(render: (...args: A) => T): (...args: A) => T {
  return (...args) => padOutput(render(...args));
}

const detailIndent = new WeakMap<Component, number>();

/** Indent details without replacing native components reused by renderers. */
export function indentDetails<T extends Component>(component: T, expanded: boolean): T {
  if (!detailIndent.has(component)) {
    const render = component.render.bind(component);
    component.render = (width) => {
      const pad = Math.min(detailIndent.get(component) ?? 0, Math.max(0, width - 1));
      return render(Math.max(1, width - pad)).map((line) => " ".repeat(pad) + line);
    };
  }
  detailIndent.set(component, expanded ? 2 : 0);
  return component;
}
