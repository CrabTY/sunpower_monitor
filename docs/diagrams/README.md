# Architecture diagram

`architecture.json` is the editable source for `architecture.svg`, which is
embedded in [Architecture](../architecture.md). The diagram describes the
implemented service; its labels contain no household deployment identifiers.

Generated with [Fireworks Tech Graph](https://github.com/yizhiyanhua-ai/fireworks-tech-graph)
1.2.0, Flat Icon style, strict text and showcase geometry checks. This is an
optional documentation tool; it is not a collector, Worker or browser dependency.

From the repository root, set `FIREWORKS_ROOT` to your installed tool directory:

```sh
python3 "$FIREWORKS_ROOT/scripts/fireworks.py" validate architecture docs/diagrams/architecture.json
python3 "$FIREWORKS_ROOT/scripts/fireworks.py" render architecture docs/diagrams/architecture.json docs/diagrams/architecture.svg
python3 "$FIREWORKS_ROOT/scripts/fireworks.py" check docs/diagrams/architecture.svg
```

Inspect a raster preview after editing labels or geometry. Keep the generated
SVG with its JSON source so GitHub can display the diagram without a renderer.
