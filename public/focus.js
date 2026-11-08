// A focus is one instruction with one or more exact, disjoint source ranges.
// Accept the original single-range shape at the simulator boundary as well.
export function focusRanges(focus) {
  return focus.ranges === undefined ? [focus] : Array.isArray(focus.ranges) ? focus.ranges : [];
}

export function rangesOverlap(a, b) {
  return a.start < b.end && b.start < a.end;
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
