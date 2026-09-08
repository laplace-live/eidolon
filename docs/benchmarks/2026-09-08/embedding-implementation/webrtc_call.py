from __future__ import annotations

import argparse
import asyncio
import contextlib
import hashlib
import json
import logging
import socket
import sys
import time
import wave
from fractions import Fraction
from pathlib import Path
from typing import Any

ROOT = Path('/Users/sparanoid/Git/laplace-eidolon')
sys.path.insert(0, str(ROOT))

from loguru import logger

logger.remove()
logging.basicConfig(level=logging.CRITICAL)

import httpx
import numpy as np
import uvicorn
from aiortc import AudioStreamTrack, RTCConfiguration, RTCPeerConnection, RTCSessionDescription
from av import AudioFrame
from pipecat.frames.frames import LLMContextFrame
from pipecat.observers.base_observer import BaseObserver, FramePushed
from pipecat.pipeline.task import PipelineTask
from pipecat.runner import run as pipecat_run

from laplace_eidolon import bot as bot_module
from laplace_eidolon import retriever

bot = bot_module.bot
OUT = Path('/tmp/eidolon-embedding-call-validation')
SOURCE = ROOT / 'docs/benchmarks/2026-09-08/call-question.wav'
state: dict[str, Any] = {
    'boundary': 'One actual local HTTP /api/offer and aiortc RTP/Opus call through unmodified bot() and SmallWebRTCTransport. In-process harness forces empty ICE-server resolution only, so host candidates connect on the same machine; excludes TURN/WAN/browser/device latency. Anonymous/no Mem0. RTVI client-ready omitted to avoid an additional greeting API turn. Existing synthetic audio question only.',
    'source': str(SOURCE.relative_to(ROOT)),
    'events': [],
    'completed': False,
}
origin = time.monotonic()
started = asyncio.Event()
connected = asyncio.Event()
replay = asyncio.Event()
turn_done = asyncio.Event()
taskbox: list[PipelineTask] = []
seen: set[Any] = set()
received: list[bytes] = []


def record(kind: str, **fields: Any) -> None:
    state['events'].append({'t': round(time.monotonic() - origin, 6), 'kind': kind, **fields})


def flush() -> None:
    OUT.joinpath('call.json').write_text(json.dumps(state, ensure_ascii=False, indent=2))


def safe_runtime(message: Any) -> None:
    item = message.record
    record('runtime_warning', module=item['name'], level=item['level'].name)


logger.add(safe_runtime, level='WARNING')
original_embed = retriever.embed_texts
original_hybrid = retriever.hybrid_search
original_search = retriever.LanceRetriever.search
original_async_send = httpx.AsyncClient.send
original_sync_send = httpx.Client.send


async def measured_embed(texts: list[str], **kwargs: Any) -> list[list[float]]:
    record('embed_start', texts=texts, model=kwargs.get('model'))
    result = await original_embed(texts, **kwargs)
    record('embed_end', count=len(result), dimension=len(result[0]) if result else 0)
    return result


async def measured_hybrid(table: Any, **kwargs: Any) -> list[dict[str, Any]]:
    record('hybrid_start', table=table.name, query=kwargs.get('query_text'),
           vector_sha256=hashlib.sha256(np.asarray(kwargs['vector'], dtype='float32').tobytes()).hexdigest(),
           candidates=kwargs.get('candidates'), top_k=kwargs.get('final_k'), rerank=kwargs.get('rerank'),
           where=kwargs.get('where'))
    result = await original_hybrid(table, **kwargs)
    record('hybrid_end', table=table.name, count=len(result),
           ids=[r.get('id') for r in result], scores=[r.get('_relevance_score') for r in result])
    return result


async def measured_search(self: Any, query: str, **kwargs: Any) -> list[dict[str, Any]]:
    record('search_start', table=self._table_name, query=query)
    result = await original_search(self, query, **kwargs)
    record('search_end', table=self._table_name, count=len(result))
    return result


async def measured_async_send(self: Any, request: Any, *args: Any, **kwargs: Any) -> Any:
    target = request.url.path.rsplit('/', 1)[-1]
    if target in {'embeddings', 'completions'}:
        record('api_start', target=target)
    result = await original_async_send(self, request, *args, **kwargs)
    if target in {'embeddings', 'completions'}:
        record('api_response', target=target, status=result.status_code)
    return result


def measured_sync_send(self: Any, request: Any, *args: Any, **kwargs: Any) -> Any:
    target = request.url.path.rsplit('/', 1)[-1]
    if target == 'rerank':
        record('api_start', target=target)
    result = original_sync_send(self, request, *args, **kwargs)
    if target == 'rerank':
        record('api_response', target=target, status=result.status_code)
    return result


retriever.embed_texts = measured_embed
retriever.hybrid_search = measured_hybrid
retriever.LanceRetriever.search = measured_search
httpx.AsyncClient.send = measured_async_send
httpx.Client.send = measured_sync_send
bot_module._resolve_ice_servers_for_aiortc = lambda: []


class Observer(BaseObserver):
    async def on_pipeline_started(self) -> None:
        record('pipeline_started')
        started.set()

    async def on_push_frame(self, data: FramePushed) -> None:
        frame = data.frame
        kind = type(frame).__name__
        if isinstance(frame, LLMContextFrame):
            key = (frame.id, data.source.name, data.destination.name)
            if key in seen:
                return
            seen.add(key)
            record(kind, frame_id=frame.id, source=data.source.name,
                   destination=data.destination.name,
                   message_count=len(frame.context.get_messages()))
        elif kind in {'TranscriptionFrame', 'UserStartedSpeakingFrame',
                      'UserStoppedSpeakingFrame', 'VADUserStoppedSpeakingFrame',
                      'LLMFullResponseStartFrame', 'LLMFullResponseEndFrame',
                      'LLMTextFrame', 'TTSStartedFrame', 'TTSStoppedFrame',
                      'BotStartedSpeakingFrame', 'BotStoppedSpeakingFrame', 'ErrorFrame'}:
            if frame.id in seen:
                return
            seen.add(frame.id)
            fields = {'text': getattr(frame, 'text')} if hasattr(frame, 'text') else {}
            record(kind, frame_id=frame.id, source=data.source.name, **fields)
            if kind == 'BotStoppedSpeakingFrame':
                turn_done.set()


class InstrumentedTask(PipelineTask):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        kwargs['observers'] = [Observer()]
        super().__init__(*args, **kwargs)
        taskbox.append(self)


bot_module.PipelineTask = InstrumentedTask


class ReplayTrack(AudioStreamTrack):
    def __init__(self) -> None:
        super().__init__()
        with wave.open(str(SOURCE), 'rb') as source:
            assert source.getframerate() == 16000
            assert source.getnchannels() == 1 and source.getsampwidth() == 2
            self.audio = source.readframes(source.getnframes())
        self.position = 0
        self.timestamp = 0
        self.begin: float | None = None
        self.replay_started = False
        self.replay_ended = False

    async def recv(self) -> AudioFrame:
        if self.begin is None:
            self.begin = time.monotonic()
        await asyncio.sleep(max(0, self.begin + self.timestamp / 16000 - time.monotonic()))
        chunk = bytes(640)
        if replay.is_set() and self.position < len(self.audio):
            if not self.replay_started:
                self.replay_started = True
                record('replay_start', duration_seconds=len(self.audio) / 32000)
            chunk = self.audio[self.position:self.position + 640].ljust(640, b'\x00')
            self.position += 640
        elif self.replay_started and not self.replay_ended:
            self.replay_ended = True
            record('replay_end')
        frame = AudioFrame(format='s16', layout='mono', samples=320)
        frame.planes[0].update(chunk)
        frame.sample_rate = 16000
        frame.pts = self.timestamp
        frame.time_base = Fraction(1, 16000)
        self.timestamp += 320
        return frame


async def receive_audio(track: Any) -> None:
    audible = False
    first = True
    while True:
        frame = await track.recv()
        array = frame.to_ndarray()
        data = array.tobytes()
        received.append(data)
        state['received_sample_rate'] = frame.sample_rate
        state['received_channels'] = len(frame.layout.channels)
        if first:
            first = False
            record('peer_first_audio_packet', sample_rate=frame.sample_rate,
                   channels=len(frame.layout.channels))
        rms = float(np.sqrt(np.mean(array.astype('float64') ** 2)))
        if rms > 100 and not audible:
            audible = True
            record('peer_first_audible_audio', rms=rms)


async def ping(channel: Any) -> None:
    while True:
        if channel.readyState == 'open':
            channel.send('ping')
        await asyncio.sleep(2)


async def main() -> None:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(('127.0.0.1', 0))
    port = sock.getsockname()[1]
    args = argparse.Namespace(ice_servers=[], esp32=False, host='127.0.0.1', folder=None)
    pipecat_run._setup_webrtc_routes(bot_module.pipecat_app, args, {})
    server = uvicorn.Server(uvicorn.Config(bot_module.pipecat_app,
                                         log_level='critical', access_log=False,
                                         timeout_graceful_shutdown=8))
    server_task = asyncio.create_task(server.serve(sockets=[sock]))
    client = RTCPeerConnection(RTCConfiguration(iceServers=[]))
    client.addTrack(ReplayTrack())
    channel = client.createDataChannel('pipecat')
    workers: list[asyncio.Task[Any]] = []

    @client.on('connectionstatechange')
    async def connection_state() -> None:
        record('peer_connection_state', value=client.connectionState)
        if client.connectionState == 'connected':
            connected.set()

    @client.on('track')
    def on_track(track: Any) -> None:
        record('peer_remote_track', media_kind=track.kind)
        if track.kind == 'audio':
            workers.append(asyncio.create_task(receive_audio(track)))

    try:
        async with asyncio.timeout(65):
            while not server.started:
                if server_task.done():
                    await server_task
                await asyncio.sleep(0.05)
            record('http_server_started')
            await client.setLocalDescription(await client.createOffer())
            assert client.localDescription is not None
            async with httpx.AsyncClient(timeout=15) as http:
                response = await http.post(f'http://127.0.0.1:{port}/api/offer', json={
                    'sdp': client.localDescription.sdp, 'type': client.localDescription.type,
                    'requestData': {},
                })
                record('offer_response', status=response.status_code)
                response.raise_for_status()
                answer = response.json()
            await client.setRemoteDescription(RTCSessionDescription(
                sdp=answer['sdp'], type=answer['type']))
            workers.append(asyncio.create_task(ping(channel)))
            await connected.wait()
            await started.wait()
            await asyncio.sleep(1)
            replay.set()
            await turn_done.wait()
            await asyncio.sleep(0.4)
            state['completed'] = True
            stats = await client.getStats()
            state['rtp_stats'] = [
                {'type': item.type,
                 **{name: getattr(item, name) for name in ['kind', 'packetsSent',
                     'packetsReceived', 'packetsLost', 'bytesSent'] if hasattr(item, name)}}
                for item in stats.values() if 'rtp' in item.type
            ]
    except BaseException as error:
        state['exception_type'] = type(error).__name__
        raise
    finally:
        await client.close()
        for task in taskbox:
            with contextlib.suppress(Exception):
                await task.cancel()
        for worker in workers:
            worker.cancel()
        await asyncio.gather(*workers, return_exceptions=True)
        server.should_exit = True
        with contextlib.suppress(Exception):
            await asyncio.wait_for(server_task, 12)
        if received:
            with wave.open(str(OUT / 'received.wav'), 'wb') as output:
                output.setnchannels(state['received_channels'])
                output.setsampwidth(2)
                output.setframerate(state['received_sample_rate'])
                output.writeframes(b''.join(received))
        state['received_bytes'] = sum(map(len, received))
        state['summary'] = {
            'embed_function_calls': sum(e['kind'] == 'embed_start' for e in state['events']),
            'embedding_http_requests': sum(e['kind'] == 'api_start' and
                e.get('target') == 'embeddings' for e in state['events']),
            'rerank_http_requests': sum(e['kind'] == 'api_start' and
                e.get('target') == 'rerank' for e in state['events']),
            'searches': [e['table'] for e in state['events'] if e['kind'] == 'search_start'],
        }
        flush()
        print(json.dumps({'completed': state['completed'], **state['summary']}, ensure_ascii=False))


if __name__ == '__main__':
    asyncio.run(main())
