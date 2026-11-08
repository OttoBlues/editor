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
  const targets = focuses.filter((item) => item.role === 'target').sort((a, b) => a.start - b.start);
  if (targets.length) {
    let previousEnd = -1;
    for (const { start, end, text, documentSnapshot } of targets) {
      if (documentSnapshot !== content || !Number.isInteger(start) || !Number.isInteger(end) ||
        start < 0 || end < start || end > content.length || start < previousEnd || content.slice(start, end) !== text) {
        throw new SuggestionError('stale_focus');
      }
      previousEnd = end;
    }
    after = content;
    for (const { start, end, text } of targets.reverse()) {
      const replacement = simulate(text, prompt, type, referenceText, language);
      after = after.slice(0, start) + replacement + after.slice(end);
    }
  } else {
    after = simulate(content, prompt, type, referenceText, language);
  }
  if (after.length > 40000 || after.split('\n').length > 400) throw new SuggestionError('too_large');
  return after;
}
