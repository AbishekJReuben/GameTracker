package __PACKAGE__;

import java.util.ArrayDeque;

/** Bounded compressed-video FIFO, independent of Android so the actual queue
 * policy can be stress-tested on a JVM. A missing P-frame invalidates ALL its
 * successors up to the next IDR; compressed frames are never latest-wins. */
final class DecoderInbox {
  // Absorb a short Wi-Fi/IPC burst without throwing away a healthy P-chain.
  // The independent age limit still prevents six slow frames becoming lag.
  static final int MAX_FRAMES = 6;
  static final int MAX_BYTES = 16_000_000;
  static final long MAX_AGE_MS = 150;

  static final class Frame {
    final long tsUs, arrivedAt;
    final boolean key;
    final byte[] data;
    final int offset, length;

    Frame(long tsUs, boolean key, byte[] data, int offset, int length, long arrivedAt) {
      this.tsUs = tsUs;
      this.key = key;
      this.data = data;
      this.offset = offset;
      this.length = length;
      this.arrivedAt = arrivedAt;
    }
  }

  private final ArrayDeque<Frame> frames = new ArrayDeque<>();
  private int bytes;
  private boolean needsKey = true;

  synchronized boolean offer(Frame frame, long now) {
    if (frame.length <= 0 || frame.length > MAX_BYTES || frame.offset < 0 ||
        frame.offset > frame.data.length - frame.length) {
      clear();
      return false;
    }
    Frame oldest = frames.peekFirst();
    if (frames.size() >= MAX_FRAMES || bytes > MAX_BYTES - frame.length ||
        (oldest != null && now - oldest.arrivedAt > MAX_AGE_MS)) clear();
    if (needsKey && !frame.key) return false;
    frames.addLast(frame);
    bytes += frame.length;
    if (frame.key) needsKey = false;
    return true;
  }

  synchronized Frame peek(long now) {
    Frame frame = frames.peekFirst();
    if (frame != null && now - frame.arrivedAt > MAX_AGE_MS) {
      clear();
      return null;
    }
    return frame;
  }

  synchronized boolean remove(Frame expected) {
    if (frames.peekFirst() != expected) return false;
    frames.removeFirst();
    bytes -= expected.length;
    return true;
  }

  synchronized void clear() {
    frames.clear();
    bytes = 0;
    needsKey = true;
  }

  synchronized int size() { return frames.size(); }
  synchronized boolean needsKey() { return needsKey; }
}
