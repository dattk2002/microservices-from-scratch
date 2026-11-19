// SHA-256 fixtures calculated independently from UTF-8 row/value pairs.
export const expectedAlgorithm = 'minhash-sha256-8-v1';

export const leftSlots = [
  'e14977cf2f1baea913f6e7419368a420234b553b6151048a1a0da7db801e8b67',
  '22bd97babc4abb3a405892ddc50f5f00cb0352bde1703b3dbd229e2b1bfe58fa',
  '07f8d1e4d1575ef69fdec727551b86900b7f0696aef15cec054ad1ac25e9fc7e',
  '04bda346f1f545ac8d7a0ce50b132d8c7ae1cd4cdb7de142a097ffd2a23cc230',
  '4025cbd7667fdd7158dd8414e49dc83d768890fac3341d95a376f451be84d8d1',
  'c891ef9055ced0fd1f25fc185061537547768e744135b26483127e06574fddf7',
  '57d713546cfb8c268b6247bd8e7e925e73f01f87cc69a6640d210746888ebb38',
  '2d6be7941febd6858e3a134ef893751b9d84c2e0ac8e36640e25e2b495e55df2',
] as const;

export const rightSlots = [
  'dad837828bc31a6d79690ed01900e3d9fa824f28577bc1792a6645a112f4abbf',
  '0e71c88aa71fa2e1b54b566b2ccf2ab0a5bb34c26c03dfb5e1097772132b7c20',
  '07f8d1e4d1575ef69fdec727551b86900b7f0696aef15cec054ad1ac25e9fc7e',
  '02c17ff2ec9779a5ebe2e433ac33499fc463dbd5b210a9929433c2a774689461',
  '2cc97fe7309f09edec09dd3a5e96d5a9e6268c7ed6fa71355ae466bed51f71ba',
  'e273b391b30eff9763834baaa65220c65e83dd3a906e41282132168a0f680f24',
  '0377ffceb9c38030bdaba1668b8a65c8d3dcbd0fd85ad79f1d6e9d3512978ce4',
  '0bbbd74f7ba2c4f1023e2d7bfef2feefc1b1a5382eee51725adc3b726b063743',
] as const;

export const unionSlots = [
  rightSlots[0], rightSlots[1], leftSlots[2], rightSlots[3],
  rightSlots[4], leftSlots[5], rightSlots[6], rightSlots[7],
];

export const emptySlots = [null, null, null, null, null, null, null, null];
export const expectedOverlap = {algorithm: expectedAlgorithm, matches: 1, similarity: 0.125, unionSlots};

export function signatureWire(byteLength: number): string {
  const signature = JSON.stringify({id: 'a', algorithm: expectedAlgorithm, slots: leftSlots});
  // Trailing JSON whitespace grows the wire body without changing any decoded field.
  return signature + ' '.repeat(byteLength - Buffer.byteLength(signature));
}
