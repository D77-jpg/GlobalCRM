/**
 * Incremental DOM translation bridge for legacy screens.
 *
 * Only translates dirty/newly inserted subtrees (never re-walks the entire document on every
 * mutation), and strictly skips editable controls, code blocks, mail bodies, and dynamic
 * user/business content (`data-user-content` / `data-no-translate` / `data-dynamic-content`).
 */
import * as React from 'react';
import { useI18n, translateText } from '@/i18n';

const SKIP_SELECTOR = 'script,style,input,textarea,pre,code,[contenteditable],[data-user-content],[data-no-translate],[data-dynamic-content],.ql-editor,.mail-body,.letter-body,.mail-preview';
const PHRASE_SAFE_SELECTOR = 'button,label,h1,h2,h3,h4,h5,th,legend,option,[role="button"],[role="tab"],[role="menuitem"]';
const TRANSLATABLE_ATTRS = ['placeholder', 'title', 'aria-label', 'alt'] as const;

const originalText = new WeakMap<Text, string>();
const originalAttrs = new WeakMap<Element, Record<string, string>>();
let originalTitle: string | null = null;

function translateAttribute(element: Element, name: string): void {
  const value = element.getAttribute(name);
  if (!value || !/[\u4e00-\u9fff]/.test(value)) return;
  const translated = translateText(value, false);
  if (translated === value) return;
  const originals = originalAttrs.get(element) ?? {};
  if (!(name in originals)) {
    originals[name] = value;
    originalAttrs.set(element, originals);
  }
  element.setAttribute(name, translated);
}

function translateSingleTextNode(text: Text): void {
  const parent = text.parentElement;
  if (!parent || parent.closest(SKIP_SELECTOR)) return;
  if (!/[\u4e00-\u9fff]/.test(text.data)) return;
  if (!originalText.has(text)) originalText.set(text, text.data);
  const allowPhrases = Boolean(parent.closest(PHRASE_SAFE_SELECTOR));
  const translated = translateText(text.data, allowPhrases);
  if (translated !== text.data) text.data = translated;
}

function translateElementSubtree(root: Node): void {
  if (root.nodeType === Node.TEXT_NODE) {
    translateSingleTextNode(root as Text);
    return;
  }
  if (!(root instanceof Element) && root !== document.body) return;
  const el = root as Element;
  if (el.closest(SKIP_SELECTOR)) return;

  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  let current = walker.nextNode();
  while (current) {
    textNodes.push(current as Text);
    current = walker.nextNode();
  }
  for (const text of textNodes) translateSingleTextNode(text);

  for (const attr of TRANSLATABLE_ATTRS) translateAttribute(el, attr);
  const candidates = el.querySelectorAll('[placeholder],[title],[aria-label],[alt]');
  for (const candidate of candidates) {
    if (candidate.closest(SKIP_SELECTOR)) continue;
    for (const attr of TRANSLATABLE_ATTRS) translateAttribute(candidate, attr);
  }
}

function restore(): void {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    const text = node as Text;
    const original = originalText.get(text);
    if (original !== undefined && text.data !== original) text.data = original;
    node = walker.nextNode();
  }
  for (const element of document.querySelectorAll('[placeholder],[title],[aria-label],[alt]')) {
    const originals = originalAttrs.get(element);
    if (!originals) continue;
    for (const [name, value] of Object.entries(originals)) element.setAttribute(name, value);
  }
  if (originalTitle) document.title = originalTitle;
  originalTitle = null;
}

function translateTitle(): void {
  if (!/[\u4e00-\u9fff]/.test(document.title)) return;
  if (!originalTitle) originalTitle = document.title;
  document.title = document.title
    .split(' · ')
    .map((part) => (part === '客户开发信管理工具' ? 'GlobalCRM' : translateText(part, false)))
    .join(' · ');
}

export function AutoTranslate(): null {
  const { language } = useI18n();

  React.useEffect(() => {
    if (language !== 'en') {
      restore();
      return;
    }

    let frameId = 0;
    const dirtyNodes = new Set<Node>();

    const flush = (): void => {
      frameId = 0;
      translateTitle();
      if (dirtyNodes.has(document.body)) {
        dirtyNodes.clear();
        translateElementSubtree(document.body);
        return;
      }
      const batch = Array.from(dirtyNodes);
      dirtyNodes.clear();
      for (const node of batch) {
        if (node.isConnected) translateElementSubtree(node);
      }
    };

    const schedule = (node: Node): void => {
      dirtyNodes.add(node);
      if (!frameId) frameId = window.requestAnimationFrame(flush);
    };

    schedule(document.body);

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          for (const added of mutation.addedNodes) {
            if (added.textContent && /[\u4e00-\u9fff]/.test(added.textContent)) schedule(added);
          }
        } else if (mutation.type === 'characterData') {
          if (mutation.target.textContent && /[\u4e00-\u9fff]/.test(mutation.target.textContent)) {
            schedule(mutation.target);
          }
        } else if (mutation.type === 'attributes' && mutation.target instanceof Element) {
          const val = mutation.attributeName ? mutation.target.getAttribute(mutation.attributeName) : null;
          if (val && /[\u4e00-\u9fff]/.test(val)) schedule(mutation.target);
        }
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: [...TRANSLATABLE_ATTRS],
    });
    const titleObserver = new MutationObserver(translateTitle);
    titleObserver.observe(document.head, { childList: true, subtree: true, characterData: true });

    return () => {
      if (frameId) window.cancelAnimationFrame(frameId);
      observer.disconnect();
      titleObserver.disconnect();
    };
  }, [language]);

  return null;
}

export default AutoTranslate;
