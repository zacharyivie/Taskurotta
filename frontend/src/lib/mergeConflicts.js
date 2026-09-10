export function conflictBlocks(text) {
  const lines = text.split('\n');
  const blocks = [];
  let start = -1; let divider = -1; let base = -1;
  lines.forEach((line, index) => {
    if (/^<{7}(?: |$)/.test(line)) { start = index; divider = -1; base = -1; }
    else if (start >= 0 && /^\|{7}(?: |$)/.test(line)) base = index;
    else if (start >= 0 && /^={7}\r?$/.test(line)) divider = index;
    else if (start >= 0 && divider > start && /^>{7}(?: |$)/.test(line)) {
      blocks.push({ start: start + 1, divider: divider + 1, end: index + 1,
        current: lines.slice(start + 1, base > start ? base : divider).join('\n'),
        incoming: lines.slice(divider + 1, index).join('\n') });
      start = -1;
    }
  });
  return blocks;
}

export function resolvedConflict(block, choice) {
  return choice === 'current' ? block.current : choice === 'incoming' ? block.incoming : [block.current, block.incoming].filter(Boolean).join('\n');
}

export function installConflictControls(monaco, editor, model) {
  if (!monaco.languages.registerCodeLensProvider || !editor.addCommand) return { dispose() {} };
  let decorations = [];
  const commands = Object.fromEntries(['current', 'incoming', 'both'].map(choice => [choice, editor.addCommand(0, (_accessor, start, version) => {
    if (editor.getOption?.(monaco.editor.EditorOption.readOnly) || model.getVersionId() !== version) return;
    const block = conflictBlocks(model.getValue()).find(item => item.start === start);
    if (!block) return;
    const hasNextLine = block.end < model.getLineCount();
    const value = resolvedConflict(block, choice);
    editor.pushUndoStop();
    editor.executeEdits('resolve-conflict', [{ range: new monaco.Range(block.start, 1, hasNextLine ? block.end + 1 : block.end, hasNextLine ? 1 : model.getLineMaxColumn(block.end)), text: value + (hasNextLine && value ? '\n' : '') }]);
    editor.pushUndoStop();
  })]));
  const provider = monaco.languages.registerCodeLensProvider('*', {
    provideCodeLenses(candidate) {
      if (candidate !== model) return { lenses: [], dispose() {} };
      return { lenses: conflictBlocks(model.getValue()).flatMap(block => ['current', 'incoming', 'both'].map(choice => ({
        range: new monaco.Range(block.start, 1, block.start, 1),
        command: { id: commands[choice], title: `Accept ${choice === 'both' ? 'both changes' : `${choice} change`}`, arguments: [block.start, model.getVersionId()] },
      }))), dispose() {} };
    },
  });
  const decorate = () => {
    decorations = editor.deltaDecorations(decorations, conflictBlocks(model.getValue()).flatMap(block => [
      { range: new monaco.Range(block.start, 1, block.divider - 1, 1), options: { isWholeLine: true, className: 'merge-current-change', glyphMarginClassName: 'merge-conflict-glyph', hoverMessage: { value: 'Current change' } } },
      { range: new monaco.Range(block.divider, 1, block.end, 1), options: { isWholeLine: true, className: 'merge-incoming-change', hoverMessage: { value: 'Incoming change' } } },
    ]));
  };
  decorate();
  const listener = model.onDidChangeContent(decorate);
  return { dispose() { listener.dispose(); provider.dispose(); } };
}
