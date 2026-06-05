import logging
import sys
from typing import List, Optional, Tuple

import numpy as np

from aiengine.models.timed import ASRToken, Sentence, Transcript


logger = logging.getLogger(__name__)


class HypothesisBuffer:
    def __init__(self, logfile=sys.stderr, confidence_validation: bool = False):
        self.confidence_validation = confidence_validation
        self.committed_in_buffer: List[ASRToken] = []
        self.buffer: List[ASRToken] = []
        self.new: List[ASRToken] = []
        self.last_committed_time = 0.0
        self.last_committed_word: Optional[str] = None
        self.logfile = logfile

    def insert(self, new_tokens: List[ASRToken], offset: float):
        new_tokens = [token.with_offset(offset) for token in new_tokens]
        self.new = [
            token
            for token in new_tokens
            if token.start > self.last_committed_time - 0.1
        ]

        if self.new:
            first_token = self.new[0]
            if (
                abs(first_token.start - self.last_committed_time) < 1
                and self.committed_in_buffer
            ):
                committed_len = len(self.committed_in_buffer)
                new_len = len(self.new)
                max_ngram = min(min(committed_len, new_len), 5)
                for i in range(1, max_ngram + 1):
                    committed_ngram = " ".join(
                        token.text for token in self.committed_in_buffer[-i:]
                    )
                    new_ngram = " ".join(token.text for token in self.new[:i])
                    if committed_ngram == new_ngram:
                        for _ in range(i):
                            self.new.pop(0)
                        break

    def flush(self) -> List[ASRToken]:
        committed: List[ASRToken] = []
        while self.new:
            current_new = self.new[0]
            if (
                self.confidence_validation
                and current_new.probability
                and current_new.probability > 0.95
            ):
                committed.append(current_new)
                self.last_committed_word = current_new.text
                self.last_committed_time = current_new.end
                self.new.pop(0)
                if self.buffer:
                    self.buffer.pop(0)
            elif not self.buffer:
                break
            elif current_new.text == self.buffer[0].text:
                committed.append(current_new)
                self.last_committed_word = current_new.text
                self.last_committed_time = current_new.end
                self.buffer.pop(0)
                self.new.pop(0)
            else:
                break
        self.buffer = self.new
        self.new = []
        self.committed_in_buffer.extend(committed)
        return committed

    def pop_committed(self, time: float):
        while self.committed_in_buffer and self.committed_in_buffer[0].end <= time:
            self.committed_in_buffer.pop(0)


class OnlineASRProcessor:
    SAMPLING_RATE = 16000

    def __init__(self, asr, logfile=sys.stderr):
        self.asr = asr
        self.tokenize = asr.tokenizer
        self.logfile = logfile
        self.confidence_validation = asr.confidence_validation
        self.global_time_offset = 0.0
        self.init()

        self.buffer_trimming_way = asr.buffer_trimming
        self.buffer_trimming_sec = asr.buffer_trimming_sec

        if self.buffer_trimming_way not in ["sentence", "segment"]:
            raise ValueError("buffer_trimming must be either 'sentence' or 'segment'")
        if self.buffer_trimming_sec <= 0:
            raise ValueError("buffer_trimming_sec must be positive")

    def new_speaker(self, change_speaker):
        self.process_iter()
        self.init(offset=change_speaker.start)

    def init(self, offset: Optional[float] = None):
        self.audio_buffer = np.array([], dtype=np.float32)
        self.transcript_buffer = HypothesisBuffer(
            logfile=self.logfile,
            confidence_validation=self.confidence_validation,
        )
        self.buffer_time_offset = offset if offset is not None else 0.0
        self.transcript_buffer.last_committed_time = self.buffer_time_offset
        self.committed: List[ASRToken] = []
        self.time_of_last_asr_output = 0.0

    def get_audio_buffer_end_time(self) -> float:
        return self.buffer_time_offset + (len(self.audio_buffer) / self.SAMPLING_RATE)

    def insert_audio_chunk(
        self, audio: np.ndarray, audio_stream_end_time: Optional[float] = None
    ):
        self.audio_buffer = np.append(self.audio_buffer, audio)

    def start_silence(self):
        if self.audio_buffer.size == 0:
            return [], self.get_audio_buffer_end_time()
        return self.process_iter()

    def end_silence(self, silence_duration: Optional[float], offset: float):
        if not silence_duration or silence_duration <= 0:
            return

        if silence_duration < 5:
            gap_samples = int(self.SAMPLING_RATE * silence_duration)
            if gap_samples > 0:
                self.insert_audio_chunk(np.zeros(gap_samples, dtype=np.float32))
        else:
            self.init(offset=silence_duration + offset)

        self.global_time_offset += silence_duration

    def insert_silence(self, silence_duration, offset):
        self.end_silence(silence_duration, offset)

    def prompt(self) -> Tuple[str, str]:
        k = len(self.committed)
        while k > 0 and self.committed[k - 1].end > self.buffer_time_offset:
            k -= 1

        prompt_tokens = self.committed[:k]
        prompt_words = [token.text for token in prompt_tokens]
        prompt_list = []
        length_count = 0
        while prompt_words and length_count < 200:
            word = prompt_words.pop(-1)
            length_count += len(word) + 1
            prompt_list.append(word)

        non_prompt_tokens = self.committed[k:]
        context_text = self.asr.sep.join(token.text for token in non_prompt_tokens)
        return self.asr.sep.join(prompt_list[::-1]), context_text

    def get_buffer(self):
        return self.concatenate_tokens(self.transcript_buffer.buffer)

    def process_iter(self) -> Tuple[List[ASRToken], float]:
        current_audio_processed_upto = self.get_audio_buffer_end_time()
        prompt_text, _ = self.prompt()

        res = self.asr.transcribe(self.audio_buffer, init_prompt=prompt_text)
        tokens = self.asr.ts_words(res)
        self.transcript_buffer.insert(tokens, self.buffer_time_offset)
        committed_tokens = self.transcript_buffer.flush()
        self.committed.extend(committed_tokens)

        if committed_tokens:
            self.time_of_last_asr_output = self.committed[-1].end

        buffer_duration = len(self.audio_buffer) / self.SAMPLING_RATE
        if not committed_tokens and buffer_duration > self.buffer_trimming_sec:
            time_since_last_output = (
                self.get_audio_buffer_end_time() - self.time_of_last_asr_output
            )
            if time_since_last_output > self.buffer_trimming_sec:
                self.init(offset=self.get_audio_buffer_end_time())
                return [], current_audio_processed_upto

        if committed_tokens and self.buffer_trimming_way == "sentence":
            if len(self.audio_buffer) / self.SAMPLING_RATE > self.buffer_trimming_sec:
                self.chunk_completed_sentence()

        seg_limit = (
            self.buffer_trimming_sec if self.buffer_trimming_way == "segment" else 30
        )
        if len(self.audio_buffer) / self.SAMPLING_RATE > seg_limit:
            self.chunk_completed_segment(res)

        return committed_tokens, current_audio_processed_upto

    def chunk_completed_sentence(self):
        buffer_duration = len(self.audio_buffer) / self.SAMPLING_RATE
        if not self.committed:
            if buffer_duration > self.buffer_trimming_sec:
                chunk_time = self.buffer_time_offset + (buffer_duration / 2)
                self.chunk_at(chunk_time)
            return

        sentences = self.words_to_sentences(self.committed)
        if len(sentences) >= 2:
            while len(sentences) > 2:
                sentences.pop(0)
            self.chunk_at(sentences[-2].end)
            return

        if buffer_duration > self.buffer_trimming_sec:
            self.chunk_at(self.committed[-1].end)

    def chunk_completed_segment(self, res):
        buffer_duration = len(self.audio_buffer) / self.SAMPLING_RATE
        if not self.committed:
            if buffer_duration > self.buffer_trimming_sec:
                chunk_time = self.buffer_time_offset + (buffer_duration / 2)
                self.chunk_at(chunk_time)
            return

        ends = self.asr.segments_end_ts(res)
        last_committed_time = self.committed[-1].end
        chunk_done = False

        if len(ends) > 1:
            e = ends[-2] + self.buffer_time_offset
            while len(ends) > 2 and e > last_committed_time:
                ends.pop(-1)
                e = ends[-2] + self.buffer_time_offset
            if e <= last_committed_time:
                self.chunk_at(e)
                chunk_done = True

        if not chunk_done and buffer_duration > self.buffer_trimming_sec:
            self.chunk_at(last_committed_time)

    def chunk_at(self, time: float):
        self.transcript_buffer.pop_committed(time)
        cut_seconds = time - self.buffer_time_offset
        self.audio_buffer = self.audio_buffer[int(cut_seconds * self.SAMPLING_RATE) :]
        self.buffer_time_offset = time

    def words_to_sentences(self, tokens: List[ASRToken]) -> List[Sentence]:
        if not tokens:
            return []

        full_text = " ".join(token.text for token in tokens)
        if self.tokenize:
            try:
                sentence_texts = self.tokenize(full_text)
            except Exception:
                sentence_texts = self.tokenize([full_text])
        else:
            sentence_texts = [full_text]

        sentences: List[Sentence] = []
        token_index = 0
        for sent_text in sentence_texts:
            sent_text = sent_text.strip()
            if not sent_text:
                continue

            sent_tokens = []
            accumulated = ""
            while token_index < len(tokens) and len(accumulated) < len(sent_text):
                token = tokens[token_index]
                accumulated = (
                    (accumulated + " " + token.text).strip()
                    if accumulated
                    else token.text
                )
                sent_tokens.append(token)
                token_index += 1

            if sent_tokens:
                sentences.append(
                    Sentence(
                        start=sent_tokens[0].start,
                        end=sent_tokens[-1].end,
                        text=" ".join(t.text for t in sent_tokens),
                    )
                )
        return sentences

    def finish(self) -> Tuple[List[ASRToken], float]:
        remaining_tokens = self.transcript_buffer.buffer
        final_processed_upto = self.buffer_time_offset + (
            len(self.audio_buffer) / self.SAMPLING_RATE
        )
        self.buffer_time_offset = final_processed_upto
        return remaining_tokens, final_processed_upto

    def concatenate_tokens(
        self,
        tokens: List[ASRToken],
        sep: Optional[str] = None,
        offset: float = 0,
    ) -> Transcript:
        sep = sep if sep is not None else self.asr.sep
        text = sep.join(token.text for token in tokens)
        if tokens:
            start = offset + tokens[0].start
            end = offset + tokens[-1].end
        else:
            start = None
            end = None
        return Transcript(start, end, text)
