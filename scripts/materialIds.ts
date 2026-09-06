/**
 * Material id table shared by the TypeScript checks. Must stay in lockstep with
 * public/gl/materials.js (MATERIALS) and design/pipeline/config.py
 * (MATERIAL_IDS); scripts/verify.sh compares all three.
 */
export const MATERIAL_IDS: Record<string, number> = {
  brick: 1, limestoneGrey: 2, limestoneBuff: 3, verdigris: 4, verdigrisDome: 5, slate: 6, terracotta: 7, glass: 8,
  concreteRibbed: 9, asphalt: 10, asphaltLine: 11, walk: 12, lawn: 13, canopy: 14, water: 15, ballast: 16, bronze: 17,
  bronzePatina: 18, granite: 19, whiteTrim: 20, concreteGrey: 21, field: 22, clapboard: 23, precast: 24, metalPanel: 25,
  glassDark: 26, roofMembrane: 27, standingSeam: 28,
};
