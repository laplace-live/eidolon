"""Per-IP sliding-window rate limit for anonymous ``/api/offer`` requests.

In-process bookkeeping: a ``dict[str, deque[float]]`` of recent attempt
timestamps per IP, pruned on every read. Viewers presenting a validated
``loginSyncToken`` bypass this entirely — see ``offer_middleware``.

Two offers from the same IP can land near-simultaneously and a naive
``if len < max: append`` would let both through, so each IP gets its own
``asyncio.Lock``. Both maps grow with the number of distinct anonymous
IPs seen and are reclaimed only by a process restart.
"""

from __future__ import annotations

import asyncio
import time
from collections import deque
from dataclasses import dataclass

from .env import env_int


@dataclass(frozen=True)
class RateLimitResult:
    """Outcome of a quota check.

    Attributes:
        remaining: slots left in the window — counted after recording the
            attempt for ``try_consume``, without taking one for ``peek``.
            Floored at 0.
        retry_after_seconds: seconds until the oldest in-window attempt
            ages out. 0 when ``allowed``.
    """

    allowed: bool
    remaining: int
    retry_after_seconds: int


class AnonymousIpQuota:
    """Sliding-window per-IP quota.

    ``time.monotonic``, not ``time.time``, so an NTP correction or VM
    clock skew during a long call can't reset or extend the window.
    """

    def __init__(self, max_per_window: int, window_seconds: int) -> None:
        # max=0 ("block every anonymous caller") is a legal config.
        self.max_per_window = max(0, max_per_window)
        self.window_seconds = max(1, window_seconds)
        self._hits: dict[str, deque[float]] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        # Guards _locks creation only, and is never held while a per-IP
        # lock is.
        self._locks_lock = asyncio.Lock()

    async def _get_lock(self, ip: str) -> asyncio.Lock:
        # Re-checked under _locks_lock so two coroutines racing to create
        # the same key don't end up holding two different lock objects.
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
        """Build a RateLimitResult, assuming ``dq`` has already been pruned.

        ``consumed=True`` means the caller already appended the attempt.
        """
        used = len(dq)
        remaining = max(0, self.max_per_window - used)
        if consumed:
            allowed = True
        else:
            allowed = used < self.max_per_window

        retry_after = 0
        if not allowed and dq:
            # Floor of 1 so the client isn't told "retry in 0 seconds"
            # and doesn't collide again on the next tick.
            retry_after = max(1, int(self.window_seconds - (now - dq[0])))
        elif not allowed:
            # max_per_window == 0 with an empty deque: no entry to age
            # out, so report the whole window.
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
        """Same answer as ``try_consume``, without recording an attempt."""
        lock = await self._get_lock(ip)
        now = time.monotonic()
        async with lock:
            dq = self._hits.setdefault(ip, deque())
            self._prune(dq, now)
            return self._build_result(dq, now, consumed=False)


# Built at import, so changing the env vars needs a restart.
ANON_QUOTA = AnonymousIpQuota(
    max_per_window=env_int("EIDOLON_ANON_RATE_LIMIT_PER_HOUR", 5),
    window_seconds=env_int("EIDOLON_ANON_RATE_LIMIT_WINDOW_SEC", 3600),
)
