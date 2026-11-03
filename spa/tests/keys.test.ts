import { describe, expect, it } from 'vitest';
import { IME_PROCESS_KEY_CODE, isImeKey, shouldSendOnEnter } from '../src/lib/keys';
import type { ComposerKeyLike } from '../src/lib/keys';

const key = (over: Partial<ComposerKeyLike> = {}): ComposerKeyLike => ({
  key: 'Enter',
  ...over,
});

describe('M41 composer key semantics', () => {
  it('a plain Enter is the explicit send', () => {
    expect(shouldSendOnEnter(key())).toBe(true);
    expect(shouldSendOnEnter(key({ keyCode: 13 }))).toBe(true);
    expect(shouldSendOnEnter(key({ isComposing: false }))).toBe(true);
  });

  it('Shift+Enter stays a newline', () => {
    expect(shouldSendOnEnter(key({ shiftKey: true }))).toBe(false);
  });

  it('Enter during IME composition never sends', () => {
    expect(isImeKey(key({ isComposing: true }))).toBe(true);
    expect(shouldSendOnEnter(key({ isComposing: true }))).toBe(false);
  });

  it('Android keyCode 229 is an IME key even when isComposing is false', () => {
    // WebView/older Safari: the IME's confirm key arrives with the legacy
    // keyCode while `key` may even read "Enter".
    expect(isImeKey(key({ keyCode: IME_PROCESS_KEY_CODE }))).toBe(true);
    expect(shouldSendOnEnter(key({ keyCode: IME_PROCESS_KEY_CODE }))).toBe(false);
    expect(shouldSendOnEnter(key({ keyCode: IME_PROCESS_KEY_CODE, shiftKey: true }))).toBe(false);
  });

  it('the 229 arm does not swallow ordinary keys', () => {
    expect(isImeKey({ key: 'a', keyCode: 65 })).toBe(false);
    expect(shouldSendOnEnter({ key: 'a', keyCode: 65 })).toBe(false);
    expect(shouldSendOnEnter({ key: 'Process', keyCode: 229 })).toBe(false);
    expect(shouldSendOnEnter({ key: 'Unidentified', keyCode: 229 })).toBe(false);
  });

  it('other keys are never a send', () => {
    for (const value of ['a', ' ', 'Tab', 'Escape', 'Backspace', 'NumpadEnter']) {
      expect(shouldSendOnEnter({ key: value })).toBe(false);
    }
  });

  it('isImeKey tolerates events without the optional fields', () => {
    expect(isImeKey({ key: 'Enter' })).toBe(false);
    expect(isImeKey({ key: 'Enter', isComposing: true })).toBe(true);
  });
});
