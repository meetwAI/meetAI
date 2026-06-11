from time import time
from typing import Any, List, Optional, Tuple, Union

from aiengine.models.timed import (
    ASRToken,
    PuncSegment,
    Segment,
    Silence,
    SilentSegment,
    SpeakerSegment,
    TimedText,
)


_DEFAULT_RETENTION_SECONDS: float = 300.0


class TokensAlignment:
    def __init__(self, state: Any, args: Any, sep: Optional[str]) -> None:
        self.state = state
        self.diarization = args.diarization

        self.all_tokens: List[ASRToken] = []
        self.all_diarization_segments: List[SpeakerSegment] = []
        self.all_translation_segments: List[Any] = []

        self.new_tokens: List[ASRToken] = []
        self.new_diarization: List[SpeakerSegment] = []
        self.new_translation: List[Any] = []
        self.new_translation_buffer: Union[TimedText, str] = TimedText()
        self.new_tokens_buffer: List[Any] = []
        self.sep: str = sep if sep is not None else " "
        self.beg_loop: Optional[float] = None

        self.validated_segments: List[Segment] = []
        self.current_line_tokens: List[ASRToken] = []
        self.diarization_buffer: List[ASRToken] = []

        self.last_punctuation = None
        self.last_uncompleted_punc_segment: PuncSegment = None
        self.unvalidated_tokens: PuncSegment = []

        self._retention_seconds: float = _DEFAULT_RETENTION_SECONDS

    def update(self) -> None:
        self.new_tokens, self.state.new_tokens = self.state.new_tokens, []
        self.new_diarization, self.state.new_diarization = (
            self.state.new_diarization,
            [],
        )
        self.new_translation, self.state.new_translation = (
            self.state.new_translation,
            [],
        )
        self.new_tokens_buffer, self.state.new_tokens_buffer = (
            self.state.new_tokens_buffer,
            [],
        )

        self.all_tokens.extend(self.new_tokens)
        self.all_diarization_segments.extend(self.new_diarization)
        self.all_translation_segments.extend(self.new_translation)
        self.new_translation_buffer = self.state.new_translation_buffer

    def _prune(self) -> None:
        if not self.all_tokens:
            return

        latest = self.all_tokens[-1].end
        cutoff = latest - self._retention_seconds
        if cutoff <= 0:
            return

        def _find_cutoff(items: list) -> int:
            for i, item in enumerate(items):
                if item.end >= cutoff:
                    return i
            return len(items)

        idx = _find_cutoff(self.all_tokens)
        if idx:
            self.all_tokens = self.all_tokens[idx:]

        idx = _find_cutoff(self.all_diarization_segments)
        if idx:
            self.all_diarization_segments = self.all_diarization_segments[idx:]

        idx = _find_cutoff(self.all_translation_segments)
        if idx:
            self.all_translation_segments = self.all_translation_segments[idx:]

        idx = _find_cutoff(self.validated_segments)
        if idx:
            self.validated_segments = self.validated_segments[idx:]

    def add_translation(self, segment: Segment) -> None:
        if segment.translation is None:
            segment.translation = ""
        for ts in self.all_translation_segments:
            if ts.is_within(segment):
                if ts.text:
                    segment.translation += ts.text + self.sep
            elif segment.translation:
                break

    def compute_punctuations_segments(
        self, tokens: Optional[List[ASRToken]] = None
    ) -> List[PuncSegment]:
        segments = []
        segment_start_idx = 0
        for i, token in enumerate(self.all_tokens):
            if token.is_silence():
                previous_segment = PuncSegment.from_tokens(
                    tokens=self.all_tokens[segment_start_idx:i]
                )
                if previous_segment:
                    segments.append(previous_segment)
                segment = PuncSegment.from_tokens(tokens=[token], is_silence=True)
                segments.append(segment)
                segment_start_idx = i + 1
            elif token.has_punctuation():
                segment = PuncSegment.from_tokens(
                    tokens=self.all_tokens[segment_start_idx : i + 1]
                )
                segments.append(segment)
                segment_start_idx = i + 1

        final_segment = PuncSegment.from_tokens(
            tokens=self.all_tokens[segment_start_idx:]
        )
        if final_segment:
            segments.append(final_segment)
        return segments

    def concatenate_diar_segments(self) -> List[SpeakerSegment]:
        if not self.all_diarization_segments:
            return []
        merged = [self.all_diarization_segments[0]]
        for segment in self.all_diarization_segments[1:]:
            if segment.speaker == merged[-1].speaker:
                merged[-1].end = segment.end
            else:
                merged.append(segment)
        return merged

    @staticmethod
    def intersection_duration(seg1: TimedText, seg2: TimedText) -> float:
        start = max(seg1.start, seg2.start)
        end = min(seg1.end, seg2.end)
        return max(0, end - start)

    def get_lines_diarization(self) -> Tuple[List[Segment], str]:
        diarization_buffer = ""
        punctuation_segments = self.compute_punctuations_segments()
        diarization_segments = self.concatenate_diar_segments()
        for punctuation_segment in punctuation_segments:
            if not punctuation_segment.is_silence():
                if (
                    diarization_segments
                    and punctuation_segment.start >= diarization_segments[-1].end
                ):
                    diarization_buffer += punctuation_segment.text
                else:
                    if punctuation_segment.tokens:
                        for token in punctuation_segment.tokens:
                            if not token.is_silence():
                                max_overlap = 0.0
                                max_overlap_speaker = 1
                                for diarization_segment in diarization_segments:
                                    intersec = self.intersection_duration(
                                        token, diarization_segment
                                    )
                                    # >= ensures newer diarization corrections
                                    # (appended later) win over older guesses
                                    # when they cover the same timespan.
                                    if intersec >= max_overlap:
                                        max_overlap = intersec
                                        max_overlap_speaker = (
                                            diarization_segment.speaker + 1
                                        )
                                token.speaker = max_overlap_speaker

        # --- Fix 3: Rebuild output segments by walking tokens chronologically
        # and splitting whenever the speaker changes.  A single punctuation
        # chunk that spans multiple speakers now produces multiple clean
        # segments instead of being collapsed under one winner.
        segments: List[Segment] = []
        current_tokens: List[ASRToken] = []
        current_speaker: Optional[int] = None

        for punc_seg in punctuation_segments:
            if punc_seg.is_silence():
                # Flush any pending speech before the silence marker.
                if current_tokens:
                    seg = Segment.from_tokens(current_tokens)
                    seg.speaker = current_speaker
                    segments.append(seg)
                    current_tokens = []
                    current_speaker = None
                segments.append(punc_seg)
            else:
                if not punc_seg.tokens:
                    continue
                for token in punc_seg.tokens:
                    if token.is_silence():
                        continue
                    if current_speaker is None:
                        current_speaker = token.speaker
                    if token.speaker != current_speaker:
                        # Speaker changed mid-chunk — emit what we have so far.
                        seg = Segment.from_tokens(current_tokens)
                        seg.speaker = current_speaker
                        segments.append(seg)
                        current_tokens = []
                        current_speaker = token.speaker
                    current_tokens.append(token)

        # Flush any tokens that did not end on a speaker change.
        if current_tokens:
            seg = Segment.from_tokens(current_tokens)
            seg.speaker = current_speaker
            segments.append(seg)

        return segments, diarization_buffer

    def get_lines(
        self,
        diarization: bool = False,
        translation: bool = False,
        current_silence: Optional[Silence] = None,
        audio_time: Optional[float] = None,
    ) -> Tuple[List[Segment], str, Union[str, TimedText]]:
        silence_now = audio_time if audio_time is not None else (time() - self.beg_loop)

        if diarization:
            segments, diarization_buffer = self.get_lines_diarization()
        else:
            diarization_buffer = ""
            for token in self.new_tokens:
                if isinstance(token, Silence):
                    if self.current_line_tokens:
                        self.validated_segments.append(
                            Segment.from_tokens(self.current_line_tokens)
                        )
                        self.current_line_tokens = []

                    end_silence = token.end if token.has_ended else silence_now
                    if (
                        self.validated_segments
                        and self.validated_segments[-1].is_silence()
                    ):
                        self.validated_segments[-1].end = end_silence
                    else:
                        self.validated_segments.append(
                            SilentSegment(start=token.start, end=end_silence)
                        )
                else:
                    self.current_line_tokens.append(token)

            segments = list(self.validated_segments)
            if self.current_line_tokens:
                segments.append(Segment.from_tokens(self.current_line_tokens))

        if current_silence:
            end_silence = (
                current_silence.end if current_silence.has_ended else silence_now
            )
            if segments and segments[-1].is_silence():
                segments[-1] = SilentSegment(start=segments[-1].start, end=end_silence)
            else:
                segments.append(
                    SilentSegment(start=current_silence.start, end=end_silence)
                )

        if translation:
            [
                self.add_translation(segment)
                for segment in segments
                if not segment.is_silence()
            ]

        self._prune()
        return segments, diarization_buffer, self.new_translation_buffer.text
