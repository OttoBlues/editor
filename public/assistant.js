import { focusRanges, focusText, validFocus } from './focus.js';

export class SuggestionError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function appendText(content, addition) {
  const trailing = /\n*$/.exec(content)[0];
  const body = content.slice(0, content.length - trailing.length);
  return body + (body ? '\n\n' : '') + addition + trailing;
}

function simulate(content, prompt, type, referenceText, language) {
  if (/引用|参考|reference/i.test(prompt)) {
    if (referenceText === null || referenceText === undefined) throw new SuggestionError('reference_required');
    return appendText(content, referenceText);
  }
  if (/空行|整理|blank|spacing/i.test(prompt)) {
    return content.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n');
  }
  if (/标题|title|heading/i.test(prompt)) {
    const title = language === 'en' ? 'Document title' : '文档标题';
    return (type === 'markdown' ? '# ' : '') + title + '\n\n' + content;
  }
  if (/摘要|总结|summary|summarize/i.test(prompt)) {
    const summary = language === 'en' ? 'A summary to be completed.' : '这里是一段待完善的摘要。';
    const heading = language === 'en' ? 'Summary' : '摘要';
    return (type === 'markdown' ? '## ' + heading + '\n\n' : heading + '：') + summary + '\n\n' + content;
  }
  const label = language === 'en' ? 'Simulated suggestion: ' : '模拟建议：';
  return appendText(content, '[' + label + prompt.replace(/\s+/g, ' ').trim() + ']');
}

export function suggest({ content, prompt, type, focus = null, focuses = focus ? [focus] : [], referenceText = null, language = 'zh-CN' }) {
  if (typeof content !== 'string' || typeof prompt !== 'string') throw new SuggestionError('invalid_input');
  if (content.length > 40000 || content.split('\n').length > 400) throw new SuggestionError('too_large');
  let after;
  const targets = focuses.filter((item) => item.role === 'target');
  if (targets.length) {
    if (targets.some((target) => !validFocus(target, content))) throw new SuggestionError('stale_focus');
    const ranges = targets.flatMap(focusRanges).sort((a, b) => a.start - b.start);
    let previousEnd = -1;
    for (const { start, end } of ranges) {
      if (start < previousEnd) throw new SuggestionError('stale_focus');
      previousEnd = end;
    }
    const edits = targets.flatMap((target) => {
      const group = [...focusRanges(target)].sort((a, b) => a.start - b.start);
      const direction = typeof target.annotation === 'string' && target.annotation.trim() ? target.annotation.trim() : prompt;
      const replacements = group.map((range) => range.text);
      if (group.length > 1 && /合并|整合|merge|combine|reorgani[sz]e/i.test(direction)) {
        // A deterministic merge demo: move selected text to the first range in
        // source order. Never include or delete the unselected gaps between them.
        replacements.fill('');
        replacements[0] = group.reduce((joined, range, index) => {
          if (!index) return range.text;
          const separatingLines = /\n*$/.exec(joined)[0].length + /^\n*/.exec(range.text)[0].length;
          return joined + '\n'.repeat(Math.max(0, 2 - separatingLines)) + range.text;
        }, '');
        // Structural ranges own their trailing separator. Keep that boundary
        // at the insertion point even when the last moved range has no newline.
        let boundary = group[0].end;
        for (const range of group.slice(1)) {
          if (range.start !== boundary) break;
          boundary = range.end;
        }
        if (boundary < content.length) {
          const boundaryLines = /\n*$/.exec(group[0].text)[0].length;
          const trailingLines = /\n*$/.exec(replacements[0])[0].length;
          const followingLines = /^\n*/.exec(content.slice(boundary))[0].length;
          replacements[0] += '\n'.repeat(Math.max(0, boundaryLines - trailingLines - followingLines));
        }
      } else if (/空行|整理|blank|spacing/i.test(direction) && !/引用|参考|reference/i.test(direction)) {
        group.forEach((range, index) => { replacements[index] = simulate(range.text, direction, type, referenceText, language); });
      } else {
        // Shared instructions create one title, summary, reference insertion or
        // simulated note for the group, rather than repeating it for each block.
        const prepend = !/引用|参考|reference/i.test(direction) && /标题|title|heading|摘要|总结|summary|summarize/i.test(direction);
        const index = prepend ? 0 : group.length - 1;
        replacements[index] = simulate(group[index].text, direction, type, referenceText, language);
      }
      return group.map((range, index) => ({ ...range, replacement: replacements[index] }));
    });
    after = content;
    for (const { start, end, replacement } of edits.sort((a, b) => b.start - a.start)) {
      after = after.slice(0, start) + replacement + after.slice(end);
    }
  } else {
    after = simulate(content, prompt, type, referenceText, language);
  }
  if (after.length > 40000 || after.split('\n').length > 400) throw new SuggestionError('too_large');
  return after;
}

// The UI may navigate freely; only explicitly watched files are edit targets.
export function suggestForAttention({ documents, attentionIds, focuses = [], references = [], prompt, language = 'zh-CN' }) {
  if (!attentionIds.length) throw new SuggestionError('no_attention');
  const targets = [...new Set(attentionIds)].map(id => documents.find(document => document.id === id));
  if (targets.some(document => !document || !document.editable)) throw new SuggestionError('invalid_target');
  const targetFocuses = focuses.filter(focus => focus.role === 'target' && focus.sourceKind === 'tab' && attentionIds.includes(focus.sourceId));
  if (!prompt && !targetFocuses.some(focus => focus.annotation?.trim())) throw new SuggestionError('empty_request');
  const referenceFocuses = focuses.filter(focus => focus.role === 'reference' && focus.sourceKind === 'tab');
  if (referenceFocuses.some(focus => !validFocus(focus, documents.find(document => document.id === focus.sourceId)?.content))) throw new SuggestionError('stale_focus');
  const referenceTexts = referenceFocuses.length ? referenceFocuses.map(focusText) : references;
  const referenceText = referenceTexts.length ? referenceTexts.join('\n\n') : null;
  return targets.flatMap(document => {
    const ranges = targetFocuses.filter(focus => focus.sourceId === document.id);
    if (!prompt && !ranges.length) return [];
    return [{ tabId: document.id, name: document.name, before: document.content,
      after: suggest({ content: document.content, type: document.type, prompt, focuses: ranges, referenceText, language }) }];
  });
}
