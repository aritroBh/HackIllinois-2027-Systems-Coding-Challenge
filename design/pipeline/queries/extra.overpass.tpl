[out:json][timeout:180];
(
  way["leisure"~"^(stadium|pitch|park|garden|track)$"]({bbox});
  way["landuse"~"^(grass|recreation_ground|forest|farmland|meadow|cemetery)$"]({bbox});
  way["natural"~"^(wood|grassland|scrub)$"]({bbox});
  way["highway"~"^(primary|secondary|tertiary|residential|unclassified|service|footway|path)$"]({bbox});
);
out geom;
