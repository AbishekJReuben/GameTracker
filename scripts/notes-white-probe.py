"""Films the floating Notes panel opening and fails if any frame shows it blank white.

Nothing else can see this bug. Windows reported the panel as hidden while the white sheet
was on screen, the page was fine, and the logs were clean. So this looks at the screen.

    npm run dev                                      (the debug shell loads its page from Vite)
    cargo build --example notes_shell                (in src-tauri)
    python scripts/notes-white-probe.py              (every scenario)
    python scripts/notes-white-probe.py warm:6000 5  (one, five times)

Set NOTES_SHELL_EXE to film another build. Build with --features tauri/custom-protocol to
test the real bundle, which doesn't need Vite.

Scenarios:
    cold-hover:<ms>  a new shell, hover, then click <ms> later
    warm:<ms>        the panel already exists and has been closed for <ms>
    load-warm:<ms>   the same with every core busy

The shell runs on a throwaway data folder. Only windows owned by that process are touched,
found by process id, so the installed orb is out of reach. A dark window sits behind the
panel while filming, so white can't be something that happened to be on screen. A run only
counts if the screen visibly changed, because a panel that never opened shows no white
either. Frames are kept only when white is found. Needs numpy and pillow.
"""
import ctypes
import ctypes.wintypes as w
import multiprocessing
import os
import shutil
import subprocess
import sys
import tempfile
import time

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXE = os.environ.get("NOTES_SHELL_EXE", os.path.join(ROOT, "src-tauri", "target", "debug", "examples", "notes_shell.exe"))
SCENARIOS = [("cold-hover:500", 3), ("cold-hover:1500", 3), ("warm:800", 6), ("warm:6000", 6), ("load-warm:3000", 5)]
# Share of the filmed area brighter than a dark UI should be. Not near zero: a finished
# panel can hold a white thumbnail.
WHITE = 0.10
BRIGHT = 120
# Mean difference, out of 255, that counts as the screen having changed.
CHANGED = 6.0

u = ctypes.WinDLL("user32")
g = ctypes.WinDLL("gdi32")
u.SetThreadDpiAwarenessContext.restype = ctypes.c_void_p
u.SetThreadDpiAwarenessContext.argtypes = [ctypes.c_void_p]
u.FindWindowExW.restype = w.HWND
u.FindWindowExW.argtypes = [w.HWND, w.HWND, w.LPCWSTR, w.LPCWSTR]
u.PostMessageW.argtypes = [w.HWND, w.UINT, w.WPARAM, w.LPARAM]
u.GetWindowThreadProcessId.argtypes = [w.HWND, ctypes.POINTER(w.DWORD)]
u.GetWindowRect.argtypes = [w.HWND, ctypes.POINTER(w.RECT)]
u.IsWindowVisible.argtypes = [w.HWND]
u.SetWindowPos.argtypes = [w.HWND, w.HWND, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, w.UINT]
u.GetDC.restype = w.HDC
u.GetDC.argtypes = [w.HWND]
g.CreateCompatibleDC.restype = w.HDC
g.CreateCompatibleDC.argtypes = [w.HDC]
g.CreateDIBSection.restype = w.HBITMAP
g.CreateDIBSection.argtypes = [w.HDC, ctypes.c_void_p, w.UINT, ctypes.POINTER(ctypes.c_void_p), w.HANDLE, w.DWORD]
g.SelectObject.restype = w.HGDIOBJ
g.SelectObject.argtypes = [w.HDC, w.HGDIOBJ]
g.BitBlt.argtypes = [w.HDC, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, w.HDC, ctypes.c_int, ctypes.c_int, w.DWORD]
PHYSICAL_PIXELS = ctypes.c_void_p(-4)
TOPMOST = w.HWND(-1)
RAISE_ONLY = 0x13
WM_MOUSEMOVE, WM_LBUTTONDOWN, WM_LBUTTONUP = 0x200, 0x201, 0x202
SRCCOPY = 0x00CC0020


def owned(pid, cls=None, title=None):
    found, after = [], None
    while True:
        after = u.FindWindowExW(None, after, cls, title)
        if not after:
            return found
        owner = w.DWORD()
        u.GetWindowThreadProcessId(after, ctypes.byref(owner))
        if owner.value == pid:
            found.append(after)


def rect(h):
    r = w.RECT()
    u.GetWindowRect(h, ctypes.byref(r))
    return r.left, r.top, r.right, r.bottom


def raise_all(windows):
    for h in windows:
        u.SetWindowPos(h, TOPMOST, 0, 0, 0, 0, RAISE_ONLY)


def backdrop(x, y, width, height):
    import tkinter

    ctypes.WinDLL("user32").SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
    window = tkinter.Tk()
    window.overrideredirect(True)
    window.attributes("-topmost", True)
    window.geometry(f"{width}x{height}+{x}+{y}")
    window.configure(bg="#1c1440")
    window.mainloop()


def busy():
    while True:
        pass


class Film:
    def __init__(self, x, y, width, height):
        self.x, self.y, self.w, self.h = x, y, width, height
        self.screen = u.GetDC(None)
        self.mem = g.CreateCompatibleDC(self.screen)
        info = (ctypes.c_int32 * 10)(40, width, -height, 1 | (32 << 16), 0, 0, 0, 0, 0, 0)
        bits = ctypes.c_void_p()
        g.SelectObject(self.mem, g.CreateDIBSection(self.screen, info, 0, ctypes.byref(bits), None, 0))
        self.pixels = (ctypes.c_ubyte * (width * height * 4)).from_address(bits.value)

    def grab(self):
        g.BitBlt(self.mem, 0, 0, self.w, self.h, self.screen, self.x, self.y, SRCCOPY)
        return np.frombuffer(self.pixels, dtype=np.uint8).reshape(self.h, self.w, 4)[:, :, 2::-1].copy()

    def watch(self, seconds, action):
        """Runs `action` and films. Returns white frames, the milliseconds when each
        white frame was taken, and whether the screen changed by the end."""

        def bright(frame):
            return float((frame[::3, ::3].min(axis=2) > BRIGHT).mean())

        before = self.grab()
        start = bright(before)
        began = time.perf_counter()
        action()
        whites, times, frame, count = [], [], before, 0
        while (now := time.perf_counter() - began) < seconds:
            frame = self.grab()
            count += 1
            if bright(frame) - start > WHITE:
                whites.append(frame)
                times.append(round(now * 1000))
        changed = float(np.abs(frame[::12, ::12].astype(np.int16) - before[::12, ::12].astype(np.int16)).mean())
        return whites, times, changed, count


class Shell:
    def __init__(self, data, exe):
        self.data, self.exe, self.process = data, exe, None

    def start(self):
        self.stop()
        env = dict(os.environ, GT_NOTES_TEST_DATA=self.data)
        self.process = subprocess.Popen([self.exe, "--notes-shell"], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        until = time.time() + 15
        while time.time() < until:
            orbs = owned(self.process.pid, "GameTrackerNotesOrb")
            if orbs:
                self.hit = orbs[0]
                return
            time.sleep(0.02)
        raise SystemExit(f"the test orb never appeared (shell exit code {self.process.poll()})")

    def stop(self):
        if self.process:
            self.process.kill()
            self.process.wait()
            self.process = None
            time.sleep(0.25)

    def orb_windows(self):
        return owned(self.process.pid, "GameTrackerNotesGlass") + [self.hit]

    def panel(self):
        found = owned(self.process.pid, "Tauri Window", "Notes")
        return found[0] if found else None

    def hover(self):
        u.PostMessageW(self.hit, WM_MOUSEMOVE, 0, 0)

    def click(self):
        u.PostMessageW(self.hit, WM_LBUTTONDOWN, 1, 0)
        time.sleep(0.03)
        u.PostMessageW(self.hit, WM_LBUTTONUP, 0, 0)


def first_open(shell):
    """Opens the panel once to learn where it lands, and returns the area to film."""
    shell.hover()
    time.sleep(0.2)
    shell.click()
    deadline = time.time() + 10
    while time.time() < deadline:
        panel = shell.panel()
        if panel and u.IsWindowVisible(panel):
            break
        time.sleep(0.02)
    else:
        raise SystemExit("the panel never opened; is Vite running on port 1420?")
    time.sleep(1.0)
    left, top, right, bottom = rect(shell.panel())
    a, b, c, d = rect(shell.hit)
    shell.click()
    time.sleep(0.6)
    return min(left, a) - 30, min(top, b) - 30, max(right, c) + 30, max(bottom, d) + 30


def run(scenario, repeats, exe, data, out):
    kind, _, delay = scenario.partition(":")
    delay = int(delay or 0) / 1000
    cold = kind.startswith("cold")
    shell = Shell(data, exe)
    shell.start()
    x0, y0, x1, y1 = first_open(shell)
    behind = multiprocessing.Process(target=backdrop, args=(x0, y0, x1 - x0, y1 - y0), daemon=True)
    behind.start()
    time.sleep(1.2)
    film = Film(x0, y0, x1 - x0, y1 - y0)
    workers = [multiprocessing.Process(target=busy, daemon=True) for _ in range(os.cpu_count() or 8)] if kind.startswith("load") else []
    for worker in workers:
        worker.start()
    flashed, unseen, closes = 0, 0, 0
    try:
        for i in range(repeats):
            if cold:
                shell.start()
                time.sleep(1.2)
            else:
                time.sleep(delay)
            # In the order they stack in real use. With the backdrop above the panel, a
            # white sheet in the panel's layer can't be seen at all.
            raise_all(owned(behind.pid))
            if shell.panel():
                raise_all([shell.panel()])
            raise_all(shell.orb_windows())
            time.sleep(0.2)

            def click():
                if cold:
                    shell.hover()
                    time.sleep(delay)
                shell.click()

            whites, times, changed, count = film.watch(delay + 3 if cold else 1.6, click)
            if changed < CHANGED:
                unseen += 1
                print(f"  run {i}: the screen never changed, so this run proves nothing")
            if whites:
                flashed += 1
                name = os.path.join(out, f"{scenario.replace(':', '-')}-{i}.png")
                Image.fromarray(whites[len(whites) // 2]).save(name)
                print(f"  run {i}: white in {len(whites)} of {count} frames, {times[0]} to {times[-1]} ms, see {name}")
            if not cold:
                whites, _, _, _ = film.watch(0.7, shell.click)
                closes += bool(whites)
                time.sleep(0.2)
    finally:
        for worker in workers:
            worker.terminate()
        behind.terminate()
        shell.stop()
    print(f"{scenario}: {repeats - flashed}/{repeats} opens clean, {unseen} not seen, {closes} closes flashed", flush=True)
    return flashed + unseen + closes == 0


def main():
    u.SetThreadDpiAwarenessContext(PHYSICAL_PIXELS)
    if not os.path.exists(EXE):
        raise SystemExit("build it first: cargo build --example notes_shell")
    plan = [(sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 3)] if len(sys.argv) > 1 else SCENARIOS
    data = tempfile.mkdtemp(prefix="gt-white-")
    out = tempfile.mkdtemp(prefix="gt-white-frames-")
    try:
        clean = [run(scenario, repeats, EXE, data, out) for scenario, repeats in plan]
    finally:
        shutil.rmtree(data, ignore_errors=True)
    if all(clean):
        shutil.rmtree(out, ignore_errors=True)
        print("no white frames")
    else:
        sys.exit(f"white frames found, kept in {out}")


if __name__ == "__main__":
    main()
