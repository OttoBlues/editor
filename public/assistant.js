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

export function suggest({ content, prompt, type, focus = null, referenceText = null, language = 'zh-CN' }) {
  if (typeof content !== 'string' || typeof prompt !== 'string') throw new SuggestionError('invalid_input');
  if (content.length > 40000 || content.split('\n').length > 400) throw new SuggestionError('too_large');
  let after;
  if (focus?.role === 'target') {
    const { start, end, text, documentSnapshot } = focus;
    if (documentSnapshot !== content || !Number.isInteger(start) || !Number.isInteger(end) ||
      start < 0 || end < start || end > content.length || content.slice(start, end) !== text) {
      throw new SuggestionError('stale_focus');
    }
    const replacement = simulate(text, prompt, type, referenceText, language);
    after = content.slice(0, start) + replacement + content.slice(end);
  } else {
    after = simulate(content, prompt, type, referenceText, language);
  }
  if (after.length > 40000 || after.split('\n').length > 400) throw new SuggestionError('too_large');
  return after;
}
