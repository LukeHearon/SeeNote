// A buzzdetect neuron's line color. A neuron named like an annotation tool
// takes that tool's color and follows it when the tool is recolored; a manual
// override (buzzdetectNeuronColors) breaks the link until it's reset. Anything
// else falls back to the palette, indexed by the FILE's neuron order so hiding
// a neuron never recolors the rest.

import { AnnotationTool } from '../types';
import { buzzdetectNeuronColor } from '../constants';
import { CUSTOM_TOOL_ID } from './annotationTools';

/** Tool colors keyed by label, for linking neurons. The Custom tool never links. */
export const toolColorsByLabel = (tools: readonly AnnotationTool[]): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const t of tools) if (t.id !== CUSTOM_TOOL_ID) out[t.text] = t.color;
  return out;
};

export const neuronColor = (
  neuron: string,
  fileIndex: number,
  overrides: Record<string, string>,
  toolColors: Record<string, string>,
): string => overrides[neuron] ?? toolColors[neuron] ?? buzzdetectNeuronColor(fileIndex);
