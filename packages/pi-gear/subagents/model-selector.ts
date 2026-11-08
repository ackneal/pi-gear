import { DynamicBorder, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Container, fuzzyFilter, Input, Spacer, Text } from "@earendil-works/pi-tui";
import type { ThinkingLevel } from "./runtime/types.ts";

type ModelChoice = ReturnType<ExtensionCommandContext["modelRegistry"]["getAvailable"]>[number];

interface Choice {
  model: ModelChoice;
}

export interface ModelSelection {
  choice: Choice;
  thinkingLevel: ThinkingLevel;
}

const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function levelsFor(model: ModelChoice): ThinkingLevel[] {
  if (!model.reasoning) return ["off"];
  return THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return typeof mapped === "string";
    return true;
  });
}

function defaultLevel(model: ModelChoice, preferred: ThinkingLevel): ThinkingLevel {
  const levels = levelsFor(model);
  return levels.includes(preferred) ? preferred : levels[0] ?? "off";
}

export async function selectSubagentModel(
  ctx: ExtensionCommandContext,
  title: string,
  choices: Choice[],
  preferredLevel: ThinkingLevel,
): Promise<ModelSelection | undefined> {
  if (ctx.mode !== "tui") {
    const labels = choices.map(({ model }) => `${model.id} [${model.provider}]`);
    const selected = choices[labels.indexOf(await ctx.ui.select(title, labels) ?? "")];
    if (!selected) return undefined;
    return { choice: selected, thinkingLevel: defaultLevel(selected.model, preferredLevel) };
  }

  return await ctx.ui.custom<ModelSelection | undefined>((tui, theme, keybindings, done) => {
    const container = new Container();
    const input = new Input();
    const list = new Container();
    const current = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
    let filtered = choices;
    let selectedIndex = 0;
    let selectedLevel = filtered[0] ? defaultLevel(filtered[0].model, preferredLevel) : "off";

    const resetLevel = (): void => {
      const selected = filtered[selectedIndex];
      selectedLevel = selected ? defaultLevel(selected.model, preferredLevel) : "off";
    };

    const rebuild = (): void => {
      list.clear();
      const maxVisible = 10;
      const start = Math.max(0, Math.min(selectedIndex - Math.floor(maxVisible / 2), filtered.length - maxVisible));
      const end = Math.min(start + maxVisible, filtered.length);

      for (let index = start; index < end; index += 1) {
        const choice = filtered[index];
        if (!choice) continue;
        const selected = index === selectedIndex;
        const active = `${choice.model.provider}/${choice.model.id}` === current;
        const prefix = selected ? theme.fg("accent", "→ ") : "  ";
        const id = selected ? theme.fg("accent", choice.model.id) : choice.model.id;
        const provider = theme.fg("muted", `[${choice.model.provider}]`);
        const variant = theme.fg("muted", index === selectedIndex ? selectedLevel : defaultLevel(choice.model, preferredLevel));
        const check = active ? theme.fg("success", " ✓") : "";
        list.addChild(new Text(`${prefix}${id} ${provider} · ${variant}${check}`, 0, 0));
      }

      if (filtered.length === 0) {
        list.addChild(new Text(theme.fg("muted", "  No matching models"), 0, 0));
        return;
      }
      if (start > 0 || end < filtered.length) {
        list.addChild(new Text(theme.fg("muted", `  (${selectedIndex + 1}/${filtered.length})`), 0, 0));
      }

      const selected = filtered[selectedIndex];
      if (selected) {
        list.addChild(new Spacer(1));
        list.addChild(new Text(theme.fg("muted", `  Model Name: ${selected.model.name}`), 0, 0));
      }
    };

    const filter = (): void => {
      const query = input.getValue();
      filtered = query
        ? fuzzyFilter(choices, query, ({ model }) => `${model.id} ${model.provider} ${model.name}`)
        : choices;
      selectedIndex = query ? 0 : Math.min(selectedIndex, Math.max(0, filtered.length - 1));
      resetLevel();
      rebuild();
    };

    container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("warning", "Only showing models from configured providers. Use /login to add providers."), 0, 0));
    container.addChild(new Spacer(1));
    container.addChild(input);
    container.addChild(new Spacer(1));
    container.addChild(list);
    container.addChild(new Spacer(1));
    container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
    rebuild();

    return {
      get focused() { return input.focused; },
      set focused(value: boolean) { input.focused = value; },
      render: (width) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data) => {
        if (keybindings.matches(data, "tui.select.up")) {
          if (filtered.length > 0) selectedIndex = selectedIndex === 0 ? filtered.length - 1 : selectedIndex - 1;
          resetLevel();
          rebuild();
        } else if (keybindings.matches(data, "tui.select.down")) {
          if (filtered.length > 0) selectedIndex = selectedIndex === filtered.length - 1 ? 0 : selectedIndex + 1;
          resetLevel();
          rebuild();
        } else if (keybindings.matches(data, "app.thinking.cycle")) {
          const selected = filtered[selectedIndex];
          if (selected) {
            const levels = levelsFor(selected.model);
            selectedLevel = levels[(levels.indexOf(selectedLevel) + 1) % levels.length] ?? "off";
            rebuild();
          }
        } else if (keybindings.matches(data, "tui.select.confirm")) {
          const selected = filtered[selectedIndex];
          done(selected ? { choice: selected, thinkingLevel: selectedLevel } : undefined);
        } else if (keybindings.matches(data, "tui.select.cancel")) {
          done(undefined);
        } else {
          input.handleInput(data);
          filter();
        }
        tui.requestRender();
      },
    };
  });
}
