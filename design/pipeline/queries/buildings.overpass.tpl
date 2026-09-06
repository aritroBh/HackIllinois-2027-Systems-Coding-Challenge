[out:json][timeout:180];
(
  nwr["building"]({bbox});
  nwr["building:part"]({bbox});
  way["leisure"="stadium"]({bbox});
);
out geom;
