import { type ModeHandlerMapImpl } from './src/mode/modeHandlerMap';
import { Mode } from './src/mode/mode';
import { Logger } from './src/util/logger';
import * as vscode from 'vscode';
import { taskQueue } from './src/taskQueue';
import { type CompositionState } from './src/state/compositionState';
import { type ModeHandler } from 'src/mode/modeHandler';
import { configuration } from './src/configuration/configuration';

export function warnIfRegistered(name: string) {
  if (myGlob.context.subscriptions.some((sub) => getMyId(sub) === name)) {
    // already registered
    void vscode.window.showErrorMessage(`My: sub '${name}' is already registered`);
  }
}

// for easier debugging, to know which subscription is which in `ctx.subscriptions`
export function setMyId(func: vscode.Disposable, id: string) {
  Object.assign(func, { myId: id });
}

export function getMyId(func: vscode.Disposable): string {
  const result = (func as unknown as Record<string, string>).myId;
  if (result == null) {
    void vscode.window.showErrorMessage('My: got undefined id');
  }
  return result;
}

const subsToRemove = [
  vscode.window.onDidChangeTextEditorSelection.name,
  'type',
  'replacePreviousChar',
  'compositionStart',
  'compositionEnd',
  'toggleVim',
];

export async function adjustSubscriptions(how: 'add' | 'remove') {
  const subscriptions = myGlob.context.subscriptions;
  if (how === 'add') {
    if (subscriptions.length !== 73) {
      void vscode.window.showErrorMessage(`My: subs are ${subscriptions.length}, not 73`);
    }
    registerDidChangeTextEditorSelectionEv();
    overrideTypeCmd();
    overrideReplacePreviousCharCmd();
    overrideCompositionStartCmd();
    overrideCompositionEndCmd();
    registerToggleVimCmd();
    if (subscriptions.length !== 79) {
      void vscode.window.showErrorMessage(`My: subs are ${subscriptions.length}, not 79`);
    }
    return;
  }

  // removing
  if (subscriptions.length !== 79) {
    void vscode.window.showErrorMessage(`My: subs are ${subscriptions.length}, not 79`);
  }
  const indexesToRemove: number[] = [];
  for (const [i, sub] of subscriptions.entries()) {
    if (subsToRemove.includes(getMyId(sub))) {
      indexesToRemove.push(i);
    }
  }
  indexesToRemove.reverse(); // to start deleting starting with high indexes, so that the other indexes remain valid
  for (const index of indexesToRemove) {
    subscriptions[index].dispose();
    subscriptions.splice(index, 1);
  }
  if (subscriptions.length !== 73) {
    void vscode.window.showErrorMessage(`My: subs are ${subscriptions.length}, not 73`);
  }
}

/** Stores things that cannot be imported without causing circular dependencies.
 * These are set from other files to be used here */
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
export const myGlob: {
  context: vscode.ExtensionContext;
  ModeHandlerMap: ModeHandlerMapImpl;
  compositionState: CompositionState;
  overrideCommand: (
    context: vscode.ExtensionContext,
    command: string,
    callback: (...args: any[]) => any,
  ) => void;
  registerCommand: (
    context: vscode.ExtensionContext,
    command: string,
    callback: (...args: any[]) => any,
    requiresActiveEditor?: boolean,
  ) => void;
  registerEventListener: <T>(
    context: vscode.ExtensionContext,
    event: vscode.Event<T>,
    listener: (e: T) => void,
    exitOnExtensionDisable: boolean,
    exitOnTests: boolean,
  ) => void;
  getAndUpdateModeHandler: (forceSyncAndUpdate?: boolean) => Promise<ModeHandler | undefined>;
  toggleExtension: (isDisabled: boolean, compositionState: CompositionState) => Promise<void>;
} = {} as any;

export function registerDidChangeTextEditorSelectionEv() {
  const context = myGlob.context;
  const compositionState = myGlob.compositionState;
  const ModeHandlerMap = myGlob.ModeHandlerMap;
  // what follows is copy paste from original `activate()`
  myGlob.registerEventListener(
    context,
    vscode.window.onDidChangeTextEditorSelection,
    async (e: vscode.TextEditorSelectionChangeEvent) => {
      if (e.textEditor.document.uri.scheme === 'output') {
        // Without this, we can an infinite logging loop
        return;
      }
      if (
        vscode.window.activeTextEditor === undefined ||
        e.textEditor.document !== vscode.window.activeTextEditor.document
      ) {
        // We don't care if user selection changed in a paneled window (e.g debug console/terminal)
        return;
      }

      const mh = ModeHandlerMap.get(vscode.window.activeTextEditor.document.uri);
      if (mh === undefined) {
        // We don't care if there is no active editor
        return;
      }

      if (e.kind !== vscode.TextEditorSelectionChangeKind.Mouse) {
        const selectionsHash = e.selections.reduce(
          (hash, s) =>
            hash +
            `[${s.anchor.line}, ${s.anchor.character}; ${s.active.line}, ${s.active.character}]`,
          '',
        );
        const idx = mh.selectionsChanged.ourSelections.indexOf(selectionsHash);
        if (idx > -1) {
          mh.selectionsChanged.ourSelections.splice(idx, 1);
          Logger.trace(
            `Ignoring selection: ${selectionsHash}. ${mh.selectionsChanged.ourSelections.length} left`,
          );
          return;
        } else if (mh.selectionsChanged.ignoreIntermediateSelections) {
          Logger.trace(`Ignoring intermediate selection change: ${selectionsHash}`);
          return;
        } else if (mh.selectionsChanged.ourSelections.length > 0) {
          // Some intermediate selection must have slipped in after setting the
          // 'ignoreIntermediateSelections' to false. Which means we didn't count
          // for it yet, but since we have selections to be ignored then we probably
          // wanted this one to be ignored as well.
          Logger.warn(`Ignoring slipped selection: ${selectionsHash}`);
          return;
        }
      }

      // We may receive changes from other panels when, having selections in them containing the same file
      // and changing text before the selection in current panel.
      if (e.textEditor !== mh.vimState.editor) {
        return;
      }

      if (mh.focusChanged) {
        mh.focusChanged = false;
        return;
      }

      if (mh.currentMode === Mode.EasyMotionMode) {
        return;
      }

      taskQueue.enqueueTask(() => mh.handleSelectionChange(e));
    },
    true,
    false,
  );
}

export function overrideTypeCmd() {
  const context = myGlob.context;
  const compositionState = myGlob.compositionState;
  const ModeHandlerMap = myGlob.ModeHandlerMap;
  const getAndUpdateModeHandler = myGlob.getAndUpdateModeHandler;
  // what follows is copy paste from original `activate()`
  myGlob.overrideCommand(context, 'type', async (args: { text: string }) => {
    taskQueue.enqueueTask(async () => {
      const mh = await getAndUpdateModeHandler();
      if (mh) {
        if (compositionState.isInComposition) {
          compositionState.composingText += args.text;
          if (mh.vimState.currentMode === Mode.Insert) {
            compositionState.insertedText = true;
            void vscode.commands.executeCommand('default:type', { text: args.text });
          }
        } else {
          await mh.handleKeyEvent(args.text);
        }
      }
    });
  });
}

export function overrideReplacePreviousCharCmd() {
  const context = myGlob.context;
  const compositionState = myGlob.compositionState;
  const ModeHandlerMap = myGlob.ModeHandlerMap;
  const getAndUpdateModeHandler = myGlob.getAndUpdateModeHandler;
  // what follows is copy paste from original `activate()`
  myGlob.overrideCommand(
    context,
    'replacePreviousChar',
    async (args: { replaceCharCnt: number; text: string }) => {
      taskQueue.enqueueTask(async () => {
        const mh = await getAndUpdateModeHandler();
        if (mh) {
          if (compositionState.isInComposition) {
            compositionState.composingText =
              compositionState.composingText.substr(
                0,
                compositionState.composingText.length - args.replaceCharCnt,
              ) + args.text;
          }
          if (compositionState.insertedText) {
            await vscode.commands.executeCommand('default:replacePreviousChar', {
              text: args.text,
              replaceCharCnt: args.replaceCharCnt,
            });
            mh.vimState.cursorStopPosition = mh.vimState.editor.selection.start;
            mh.vimState.cursorStartPosition = mh.vimState.editor.selection.start;
          }
        } else {
          await vscode.commands.executeCommand('default:replacePreviousChar', {
            text: args.text,
            replaceCharCnt: args.replaceCharCnt,
          });
        }
      });
    },
  );
}

export function overrideCompositionStartCmd() {
  const context = myGlob.context;
  const compositionState = myGlob.compositionState;
  const ModeHandlerMap = myGlob.ModeHandlerMap;
  const getAndUpdateModeHandler = myGlob.getAndUpdateModeHandler;
  // what follows is copy paste from original `activate()`
  myGlob.overrideCommand(context, 'compositionStart', async () => {
    taskQueue.enqueueTask(async () => {
      compositionState.isInComposition = true;
    });
  });
}

export function overrideCompositionEndCmd() {
  const context = myGlob.context;
  const compositionState = myGlob.compositionState;
  const ModeHandlerMap = myGlob.ModeHandlerMap;
  const getAndUpdateModeHandler = myGlob.getAndUpdateModeHandler;
  // what follows is copy paste from original `activate()`
  myGlob.overrideCommand(context, 'compositionEnd', async () => {
    taskQueue.enqueueTask(async () => {
      const mh = await getAndUpdateModeHandler();
      if (mh) {
        if (compositionState.insertedText) {
          mh.selectionsChanged.ignoreIntermediateSelections = true;
          await vscode.commands.executeCommand('default:replacePreviousChar', {
            text: '',
            replaceCharCnt: compositionState.composingText.length,
          });
          mh.vimState.cursorStopPosition = mh.vimState.editor.selection.active;
          mh.vimState.cursorStartPosition = mh.vimState.editor.selection.active;
          mh.selectionsChanged.ignoreIntermediateSelections = false;
        }
        const text = compositionState.composingText;
        await mh.handleMultipleKeyEvents(text.split(''));
      }
      compositionState.reset();
    });
  });
}

export function registerToggleVimCmd() {
  const context = myGlob.context;
  const compositionState = myGlob.compositionState;
  const toggleExtension = myGlob.toggleExtension;
  // what follows is copy paste from original `activate()`
  myGlob.registerCommand(context, 'toggleVim', async () => {
    configuration.disableExtension = !configuration.disableExtension;
    void toggleExtension(configuration.disableExtension, compositionState);
  });
}
