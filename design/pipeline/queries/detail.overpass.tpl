[out:json][timeout:180];
(
  node["natural"="tree"]({bbox});
  node["highway"="street_lamp"]({bbox});
  node["amenity"="fountain"]({bbox});
  way["amenity"="fountain"]({bbox});
  way["amenity"="parking"]({bbox});
  way["waterway"]({bbox});
  way["natural"="water"]({bbox});
  way["railway"="rail"]({bbox});
);
out geom;
