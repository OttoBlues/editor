// A focus is one instruction with one or more exact, disjoint source ranges.
// Accept the original single-range shape at the simulator boundary as well.
export function focusRanges(focus) {
  return focus.ranges === undefined ? [focus] : Array.isArray(focus.ranges) ? focus.ranges : [];
}

export function rangesOverlap(a, b) {
  return a.start < b.end && b.start < a.end;
}

// Overlay exact selections on a visible source interval. Automatic blocks are
// split around them so selecting a few words never hides the remaining text.
export function focusCanvasBlocks(content, candidates, selected, start = 0, end = content.length) {
  const choices = selected.filter((range) => range.start < end && range.end > start).sort((a, b) => a.start - b.start);
  const blocks = choices.map((range) => ({ ...range, start: Math.max(start, range.start), end: Math.min(end, range.end) }));
  for (const candidate of candidates) {
    let position = Math.max(start, candidate.start);
    const limit = Math.min(end, candidate.end);
    function fragment(until) {
      if (until <= position) return;
      blocks.push(position === candidate.start && until === candidate.end ? { ...candidate } : { kind: 'selection', start: position, end: until });
    }
    for (const range of choices) {
      if (range.end <= position) continue;
      if (range.start >= limit) break;
      fragment(range.start);
      position = Math.max(position, range.end);
    }
    fragment(limit);
  }
  blocks.sort((a, b) => a.start - b.start);
  const result = [];
  let position = start;
  for (const block of blocks) {
    if (block.start > position) result.push({ kind: 'document', start: position, end: block.start });
    result.push(block);
    position = block.end;
  }
  if (position < end) result.push({ kind: 'document', start: position, end });
  let line = 1;
  let newline = content.indexOf('\n');
  for (const block of result) {
    while (newline >= 0 && newline < block.start) { line += 1; newline = content.indexOf('\n', newline + 1); }
    block.line = line;
  }
  return result;
}

export function validFocus(focus, content) {
  const ranges = [...focusRanges(focus)];
  if (ranges.some((range) => !range)) return false;
  ranges.sort((a, b) => a.start - b.start);
  if (focus.documentSnapshot !== content || !ranges.length) return false;
  let previousEnd = -1;
  for (const range of ranges) {
    if (!range || !Number.isInteger(range.start) || !Number.isInteger(range.end) ||
      range.start < 0 || range.end <= range.start || range.end > content.length ||
      range.start < previousEnd || content.slice(range.start, range.end) !== range.text) return false;
    previousEnd = range.end;
  }
  return true;
}

export function focusText(focus) {
  return [...focusRanges(focus)].sort((a, b) => a.start - b.start).map((range) => range.text).join('\n\n');
}
