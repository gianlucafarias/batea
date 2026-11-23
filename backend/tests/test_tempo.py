"""BPM: el detector viejo se enganchaba en el tresillo (143 → 95,33) o en 4/5 (140 → 112) en temas duros."""
import unittest

import numpy as np

from batea import tempo

SR = 22050


def hard_techno(bpm: float, seconds: float = 40.0, sr: int = SR) -> np.ndarray:
    """Bombo en cada negra + hi-hats en tresillo (más fuertes que el bombo en agudos) + ruido."""
    rng = np.random.default_rng(1)
    n = int(seconds * sr)
    y = 0.02 * rng.standard_normal(n)
    beat = 60.0 / bpm
    t = np.arange(int(0.18 * sr)) / sr
    kick = np.sin(2 * np.pi * (50 + 120 * np.exp(-t * 30)) * t) * np.exp(-t * 14)
    th = np.arange(int(0.03 * sr)) / sr
    hat = rng.standard_normal(len(th)) * np.exp(-th * 120) * 0.9
    for k in np.arange(0, seconds - 0.2, beat):
        i = int(k * sr)
        y[i:i + len(kick)] += kick
    for k in np.arange(0, seconds - 0.05, beat * 2 / 3):        # tresillo de corcheas
        i = int(k * sr)
        y[i:i + len(hat)] += hat
    return (y / np.abs(y).max()).astype(np.float32)


class TempoTest(unittest.TestCase):
    def _onset_path(self, y: np.ndarray) -> float:
        import librosa

        S = np.abs(librosa.stft(y, n_fft=2048, hop_length=512))
        fr = librosa.fft_frequencies(sr=SR, n_fft=2048)
        lo = np.sqrt((S[fr < 200] ** 2).sum(axis=0))
        flux = np.maximum(0.0, np.diff(lo, prepend=lo[:1]))
        on = librosa.onset.onset_strength(y=y, sr=SR, hop_length=512, aggregate=np.median)
        n = min(len(flux), len(on))
        return tempo.refine(y, SR, tempo.onset_bpm(flux[:n], on[:n], SR / 512))

    def test_onset_path_ignores_triplets(self):
        for bpm in (128.0, 140.0, 143.0, 150.0):
            with self.subTest(bpm=bpm):
                self.assertAlmostEqual(self._onset_path(hard_techno(bpm)), bpm, delta=0.3)

    def test_with_essentia_triplets_do_not_win(self):
        try:
            import essentia  # noqa: F401
        except ImportError:
            self.skipTest("sin Essentia (versión Intel)")
        import librosa

        for bpm in (140.0, 143.0):
            with self.subTest(bpm=bpm):
                y = hard_techno(bpm)
                a44 = librosa.resample(y, orig_sr=SR, target_sr=44100)
                S = np.abs(librosa.stft(y, n_fft=2048, hop_length=512))
                fr = librosa.fft_frequencies(sr=SR, n_fft=2048)
                lo = np.sqrt((S[fr < 200] ** 2).sum(axis=0))
                on = librosa.onset.onset_strength(y=y, sr=SR, hop_length=512, aggregate=np.median)
                est = tempo.estimate(y, SR, lo, on, 512, a44)
                self.assertAlmostEqual(est, bpm, delta=0.3)

    def test_snap_and_fold(self):
        self.assertEqual(tempo.snap(127.96), 128.0)
        self.assertEqual(tempo.snap(135.46), 135.46)
        self.assertEqual(tempo.fold(71.5), 143.0)


if __name__ == "__main__":
    unittest.main()
