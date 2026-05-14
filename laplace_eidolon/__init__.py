"""laplace-eidolon — Pipecat voice bot for a streamer RP persona.

Package layout:

- :mod:`laplace_eidolon.bot`             — entry point; ``python -m laplace_eidolon.bot``
- :mod:`laplace_eidolon.openrouter`      — shared OpenRouter request headers + cost helper
- :mod:`laplace_eidolon.embeddings`      — embedding client + LanceDB infra (write path)
- :mod:`laplace_eidolon.retrieval`       — hybrid search + zh tokenizer + rerank (read path)
- :mod:`laplace_eidolon.persona_facts`   — Pipecat processor: RAG over hand-compiled facts
- :mod:`laplace_eidolon.stream_archive`  — Pipecat processor: RAG over refined transcripts
- :mod:`laplace_eidolon.tools`           — offline batch utilities (ingest, refine, search, …)

The bot itself is intentionally not a console-script entry point: Pipecat's
runner discovers the ``bot()`` function via ``sys.modules["__main__"]``,
which a generated console-script launcher doesn't satisfy. The offline
tools are exposed as ``laplace-*`` console scripts via
``[project.scripts]`` in ``pyproject.toml``.
"""
