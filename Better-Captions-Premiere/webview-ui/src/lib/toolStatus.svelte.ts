// Small bits of state each tool reports back, shown on the home screen.
export const toolStatus = $state<{ bpm: number | null; beatsSource: string | null; lut: string | null }>({
  bpm: null,
  beatsSource: null,
  lut: null,
});
