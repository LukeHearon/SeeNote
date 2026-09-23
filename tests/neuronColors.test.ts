import { describe, it, expect } from 'vitest';
import { neuronColor, toolColorsByLabel } from '../utils/neuronColors';
import { makeCustomTool } from '../utils/annotationTools';
import { buzzdetectNeuronColor } from '../constants';

const tools = [
  makeCustomTool('#ffffff'),
  { id: 'a', key: '1', text: 'ins_buzz', color: '#ef4444' },
];

describe('neuronColor', () => {
  const linked = toolColorsByLabel(tools);

  it('takes the matching tool color', () => {
    expect(neuronColor('ins_buzz', 0, {}, linked)).toBe('#ef4444');
  });

  it('lets a manual override win over the tool', () => {
    expect(neuronColor('ins_buzz', 0, { ins_buzz: '#000000' }, linked)).toBe('#000000');
  });

  it('falls back to the palette by file index', () => {
    expect(neuronColor('wasp', 3, {}, linked)).toBe(buzzdetectNeuronColor(3));
  });

  it('never links to the Custom tool', () => {
    expect(neuronColor('Custom', 2, {}, linked)).toBe(buzzdetectNeuronColor(2));
  });
});
