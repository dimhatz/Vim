import { Mode } from './src/mode/mode';
import { Logger } from './src/util/logger';
import * as vscode from 'vscode';

export function setMyId(func: vscode.Disposable, id: string) {
  Object.assign(func, { myId: id });
}

export function getMyId(func: vscode.Disposable): string | undefined {
  return (func as unknown as Record<string, string>).myId;
}

export function setPreservable(func: vscode.Disposable) {
  Object.assign(func, { preserveMe: true });
}

export function isPreservable(func: vscode.Disposable): boolean {
  return (func as unknown as Record<string, boolean>).preserveMe === true;
}

export async function adjustSubscriptions(currentMode: Mode, targetMode: Mode) {
  if (currentMode == null || targetMode == null || currentMode === targetMode) {
    return;
  }

  if (targetMode === Mode.Insert) {
    // disable subs except preserved
    const indexesToRemove: number[] = [];
    for (const [i, sub] of myGlob.ctx.subscriptions.entries()) {
      if (!isPreservable(sub)) {
        indexesToRemove.push(i);
      }
    }
    indexesToRemove.reverse(); // to start deleting starting with high indexes, so that the other indexes remain valid
    for (const index of indexesToRemove) {
      myGlob.ctx.subscriptions[index].dispose();
      myGlob.ctx.subscriptions.splice(index, 1);
    }
  } else {
    if (currentMode !== Mode.Insert) {
      // the listeners are already registered
      return;
    }
    // reenable sub when we go from insert -> other mode
    await myGlob.activate(myGlob.ctx);
    Logger.debug('My: reactivated');
  }
}

// not importing from extensionBase.ts to avoid circular dependency
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
export const myGlob: {
  ctx: vscode.ExtensionContext;
  activate: (context: vscode.ExtensionContext, handleLocal?: boolean) => Promise<void>;
} = {} as any;
