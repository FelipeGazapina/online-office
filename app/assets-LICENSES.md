# Bundled assets

Every asset in `src/renderer/src/assets/` is CC0 (public domain dedication, https://creativecommons.org/publicdomain/zero/1.0/).
The license was read on each asset's own page before download. Nothing is fetched at runtime; the files ship inside the build.

## Textures (`src/renderer/src/assets/textures/<surface>/`)

Each folder holds `diff.jpg` (colour), `nor.jpg` (OpenGL normal) and `arm.jpg` (ambient occlusion in red, roughness in green), at 1024 px.

| Surface | Source asset | Page | License |
| --- | --- | --- | --- |
| wood | Laminate Floor 02, Poly Haven | https://polyhaven.com/a/laminate_floor_02 | CC0 |
| tile | Large Floor Tiles 02, Poly Haven | https://polyhaven.com/a/large_floor_tiles_02 | CC0 |
| concrete | Concrete Floor 02, Poly Haven | https://polyhaven.com/a/concrete_floor_02 | CC0 |
| plaster | Beige Wall 001, Poly Haven | https://polyhaven.com/a/beige_wall_001 | CC0 |
| carpet | Carpet 014, ambientCG (Color, NormalGL and Roughness maps; ARM packed from Roughness) | https://ambientcg.com/a/Carpet014 | CC0 |

## Models (`src/renderer/src/assets/models/`)

Each prop is baked by `src/renderer/src/assets/bake/bake-props.mjs` from the sources below: welded into one mesh and one material, resized, simplified
where heavy, with its maps packed into one atlas (`<name>-diff.jpg`, `<name>-nor.jpg`, `<name>-arm.jpg`, 512 or 1024 px per source material).
Kenney's chair has flat material colours, so it ships as vertex colours with no maps.

| Prop | Source asset | Page | License |
| --- | --- | --- | --- |
| desk | Wooden Table 02, Poly Haven | https://polyhaven.com/a/wooden_table_02 | CC0 |
| sofa | Sofa 03, Poly Haven | https://polyhaven.com/a/sofa_03 | CC0 |
| armchair | Modern Arm Chair 01, Poly Haven | https://polyhaven.com/a/modern_arm_chair_01 | CC0 |
| bookshelf | Wooden Bookshelf Worn, Poly Haven | https://polyhaven.com/a/wooden_bookshelf_worn | CC0 |
| plant_ficus, plant_tall | Potted Plant 01, Poly Haven (simplified) | https://polyhaven.com/a/potted_plant_01 | CC0 |
| plant_syngonium | Potted Plant 02, Poly Haven (simplified) | https://polyhaven.com/a/potted_plant_02 | CC0 |
| plant_succulent | Potted Plant 04, Poly Haven | https://polyhaven.com/a/potted_plant_04 | CC0 |
| lamp | Modern Ceiling Lamp 01, Poly Haven (cord shortened) | https://polyhaven.com/a/modern_ceiling_lamp_01 | CC0 |
| chair | `chairDesk`, Kenney Furniture Kit 2.0 | https://kenney.nl/assets/furniture-kit | CC0 |
| desk_lamp | Desk Lamp Arm 01, Poly Haven (simplified to 2,500 triangles) | https://polyhaven.com/a/desk_lamp_arm_01 | CC0 |
| laptop | Classic Laptop, Poly Haven (simplified to 2,700 triangles, screen glass given a flat map) | https://polyhaven.com/a/classic_laptop | CC0 |
| picture_frame | Standing Picture Frame 01, Poly Haven (simplified, turned to face +z) | https://polyhaven.com/a/standing_picture_frame_01 | CC0 |
| vase | Ceramic Vase 01, Poly Haven (simplified to 2,000 triangles) | https://polyhaven.com/a/ceramic_vase_01 | CC0 |
| desk_clock | Alarm Clock 01, Poly Haven (simplified to 2,500 triangles) | https://polyhaven.com/a/alarm_clock_01 | CC0 |

The five small props above stand on desks, tables and shelves (`ItemDef.top`). The small plants on tops are the `plant_succulent` prop of
Potted Plant 04. The books, papers, mug, pen cup and trophy have no source file: they are boxes and cylinders written in
`src/renderer/src/scene/building/tabletop.ts`, original to this repository, and so carry no third-party license.
