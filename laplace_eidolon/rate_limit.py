"""Per-IP sliding-window rate limit for anonymous /api/offer requests.

The bot exposes a single rate-limited surface: anonymous WebRTC offers.
Once a viewer presents a valid ``loginSyncToken`` they bypass this entirely
(see :mod:`offer_middleware`). This module keeps the bookkeeping in-process:
a ``dict[str, deque[float]]`` of recent attempt timestamps per IP, pruned
on every read.

Why in-process is enough
------------------------
- The deployment topology is single-instance (Docker on one VPS, per
  ``README.md``).
- Restarting the bot wipes the quota — that's fine; spammers who timed
  out are no worse off than a freshly-launched bot.
- The lock-per-IP dance below assumes one Python process; multi-replica
  topologies would need Redis / Workers KV / D1. Out of scope.

Concurrency
-----------
Two offers from the same IP can land near-simultaneously. A naive
``if len < max: append`` race would let both through. We serialise per-IP
via :class:`asyncio.Lock` instances stored alongside the deques. The
shared ``_locks_lock`` only protects the dict-of-locks creation, so
concurrent distinct IPs never contend with each other.

Memory bound
------------
``_hits`` and ``_locks`` grow with the cardinality of distinct anonymous
IPs the bot has ever seen, bounded by the lifetime of the process. For a
typical self-hosted deployment that's a few KB at worst — bot restarts
(deploys, idle timeouts) garbage-collect this implicitly. A scheduled
sweep would be over-engineered.
"""

from __future__ import annotations

import asyncio
import os
import time
from collections import deque
from dataclasses import dataclass

from loguru import logger


@dataclass(frozen=True)
class RateLimitResult:
    """Outcome of a quota check.

    Attributes:
        allowed: True when the attempt should proceed. For
            :meth:`AnonymousIpQuota.try_consume` this also means a slot
            has been recorded; for :meth:`AnonymousIpQuota.peek` it
            means a subsequent ``try_consume`` would succeed (modulo
            races, but the preflight is best-effort by design).
        remaining: Slots left in the current window. After
            ``try_consume`` this is the count AFTER the new attempt is
            recorded; for ``peek`` it's the count without taking one.
            Floored at 0.
        retry_after_seconds: Seconds until the oldest in-window attempt
            ages out and a fresh slot becomes available. 0 when
            ``allowed=True`` or when nothing is pending.
    """

    allowed: bool
    remaining: int
    retry_after_seconds: int


def _env_int(name: str, default: int) -> int:
    """Parse an int env var with empty-string-fallback semantics.

    ``cp .env.example .env`` produces empty values; ``int("")`` would
    blow up at import. Matches the pattern used by ``CF_TURN_TTL_SEC``
    in :mod:`bot`.
    """
    raw = os.getenv(name)
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        logger.warning(
            f"[rate-limit] {name}={raw!r} is not a valid int; using default {default}"
        )
        return default


class AnonymousIpQuota:
    """Sliding-window per-IP quota.

    Each attempt records ``time.monotonic()`` in a deque keyed by IP.
    On every check we prune entries older than ``window_seconds`` and
    compare the remaining count to ``max_per_window``.

    ``time.monotonic`` (not ``time.time``) so the quota is immune to
    wall-clock jumps — NTP corrections or VM clock skew during a
    long-running call can't accidentally reset or extend the window.
    """

    def __init__(self, max_per_window: int, window_seconds: int) -> None:
        # max=0 is "block everything anonymous"; we allow it. Window
        # must be positive to avoid divide-by-window edge cases below.
        self.max_per_window = max(0, max_per_window)
        self.window_seconds = max(1, window_seconds)
        self._hits: dict[str, deque[float]] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        # Guards _locks creation only — never held while a per-IP lock
        # is. Two coroutines hitting distinct IPs never contend here
        # after the first lookup.
        self._locks_lock = asyncio.Lock()

    async def _get_lock(self, ip: str) -> asyncio.Lock:
        # Fast path: most lookups hit an existing lock and avoid the
        # outer mutex entirely. The miss path serialises through
        # _locks_lock so two coroutines racing to create the same key
        # don't end up with two different lock objects.
        lock = self._locks.get(ip)
        if lock is not None:
            return lock
        async with self._locks_lock:
            lock = self._locks.get(ip)
            if lock is None:
                lock = asyncio.Lock()
                self._locks[ip] = lock
            return lock

    def _prune(self, dq: deque[float], now: float) -> None:
        cutoff = now - self.window_seconds
        while dq and dq[0] < cutoff:
            dq.popleft()

    def _build_result(
        self, dq: deque[float], now: float, *, consumed: bool
    ) -> RateLimitResult:
        """Build a RateLimitResult assuming ``dq`` has been pruned.

        ``consumed=True`` means the caller already appended the current
        attempt to the deque, so ``remaining`` is the count AFTER
        consumption. ``consumed=False`` is the peek path — ``allowed``
        reflects whether a hypothetical ``try_consume`` would succeed.
        """
        used = len(dq)
        remaining = max(0, self.max_per_window - used)
        if consumed:
            allowed = True
        else:
            allowed = used < self.max_per_window

        retry_after = 0
        if not allowed and dq:
            # Seconds until the oldest in-window entry ages out. Floor
            # of 1 so the client doesn't get told "retry in 0 seconds"
            # and immediately collide on the next tick.
            retry_after = max(1, int(self.window_seconds - (now - dq[0])))
        elif not allowed:
            # max_per_window == 0 and dq is empty — there's no entry to
            # age out, so report the full window. Pathological config
            # but worth being honest about.
            retry_after = self.window_seconds
        return RateLimitResult(
            allowed=allowed,
            remaining=remaining,
            retry_after_seconds=retry_after,
        )

    async def try_consume(self, ip: str) -> RateLimitResult:
        """Atomically check + record an attempt for ``ip``."""
        lock = await self._get_lock(ip)
        now = time.monotonic()
        async with lock:
            dq = self._hits.setdefault(ip, deque())
            self._prune(dq, now)
            if len(dq) >= self.max_per_window:
                return self._build_result(dq, now, consumed=False)
            dq.append(now)
            return self._build_result(dq, now, consumed=True)

    async def peek(self, ip: str) -> RateLimitResult:
        """Same answer as ``try_consume`` would give, but DO NOT record.

        Used by the preflight endpoint so a successful preflight + real
        offer counts as ONE attempt, not two.
        """
        lock = await self._get_lock(ip)
        now = time.monotonic()
        async with lock:
            dq = self._hits.setdefault(ip, deque())
            self._prune(dq, now)
            return self._build_result(dq, now, consumed=False)


# Module-level singleton. Constructed once at import time so subsequent
# os.environ mutations don't silently take effect mid-run — matches the
# rest of the bot's "read env at boot, restart to change" posture.
ANON_QUOTA = AnonymousIpQuota(
    max_per_window=_env_int("EIDOLON_ANON_RATE_LIMIT_PER_HOUR", 5),
    window_seconds=_env_int("EIDOLON_ANON_RATE_LIMIT_WINDOW_SEC", 3600),
)
