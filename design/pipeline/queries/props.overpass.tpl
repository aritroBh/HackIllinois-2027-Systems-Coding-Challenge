// Props: the street furniture and small detail pass. Why each category is here, and why the
// node/way/nwr choice per feature, is in design/pipeline/README.md — the whole template is
// hashed into the fetch manifest, so prose in this file makes every reworded sentence a
// sixteen-request refetch against a rate-limited public endpoint.
//
// One rule governs the list: every selector below must have a consumer in
// design/pipeline/props.py, and every branch of props.py's `_kind_for` must have a selector
// here. A tag fetched with no consumer is bytes and cache churn for nothing; a consumer with
// no selector is a branch that can never run. `npm run campus:check` asserts the pairing.
[out:json][timeout:180];
(
  // Amenity nodes. All single points, all drawn as a small placed prop.
  node["amenity"="bench"]({bbox});
  node["amenity"~"^(waste_basket|waste_disposal)$"]({bbox});
  node["amenity"="drinking_water"]({bbox});
  node["amenity"="post_box"]({bbox});

  // Bicycle parking and shelters are mapped as a point on small sites and as an outline on
  // large ones. Both forms are asked for explicitly rather than through nwr, because the
  // relation form has no consumer: build_props takes nodes and ways and skips everything else,
  // so a relation is downloaded, hashed and discarded.
  node["amenity"="bicycle_parking"]({bbox});
  way["amenity"="bicycle_parking"]({bbox});
  node["amenity"="shelter"]({bbox});
  way["amenity"="shelter"]({bbox});

  // Transit furniture. A crossing and a traffic signal are deliberately absent: a crossing is
  // a painted band between two kerbs, which the renderer draws as a ground decal from the road
  // geometry it already has, and neither has a prop mesh.
  node["highway"="bus_stop"]({bbox});
  way["highway"="steps"]({bbox});

  // Barriers, split by the geometry each value actually carries. Fences, walls and hedges are
  // linear and define the edges of quads; bollards and gates are point thresholds on a path.
  // fence_type rides along on the way and picks the railing profile.
  way["barrier"~"^(fence|wall|hedge|retaining_wall|city_wall)$"]({bbox});
  node["barrier"~"^(bollard|gate|lift_gate|swing_gate)$"]({bbox});

  // Leisure surfaces and their furniture. The pitch way brings its sport tag along, which the
  // baker uses to choose surface colour and court markings. A playground is mapped as a point
  // as often as an outline, so both are asked for.
  node["leisure"="picnic_table"]({bbox});
  node["leisure"="playground"]({bbox});
  way["leisure"="playground"]({bbox});
  way["leisure"="pitch"]({bbox});

  // Plaza anchors. Wanted as points to place a single sculpted prop, so the way and relation
  // forms of large memorial grounds are deliberately not requested. historic=monument is also
  // absent: monuments.py owns those, hand-fed from the pack.
  node["tourism"="artwork"]({bbox});
  node["tourism"="information"]({bbox});
  node["historic"="memorial"]({bbox});

  // Tall thin verticals. Each is extruded from its node with a stock profile, so the footprint
  // way would tell us nothing the point does not. A communication tower is a mast in all but
  // the tag.
  node["man_made"~"^(flagpole|mast|water_tower|chimney|planter|tower)$"]({bbox});

  // Hydrants are pure decoration at kerb scale but they are dense and free, and they read as
  // American campus street the moment they appear.
  node["emergency"="fire_hydrant"]({bbox});
);
out geom;
