import 'dart:async';
import 'dart:convert';
import 'dart:ffi';
import 'dart:io';
import 'dart:isolate';
import 'dart:typed_data';

import 'package:ffi/ffi.dart';

/// reeval's messages, on private copies of the runner's fd 0 and fd 1.
///
/// Once it's open, fd 0 reads `/dev/null` and fd 1 writes to stderr, so a child
/// process, a native library or an eval's own `stdout.write` can neither read a
/// message nor write into one.
final class MessageChannel {
  MessageChannel._(this.input, this._write);

  /// reeval's messages, one JSON object a line.
  final Stream<String> input;
  final void Function(String line) _write;

  /// Writes one message as a line of JSON.
  void send(Map<String, Object?> message) => _write(jsonEncode(message));

  static MessageChannel open() {
    if (Platform.isWindows) {
      return MessageChannel._(_lines(stdin), (line) => stdout.writeln(line));
    }
    final libc = _Libc();
    final inFd = libc.dup(0), outFd = libc.dup(1);
    if (inFd < 0 || outFd < 0) {
      throw const OSError("couldn't copy the runner's stdin and stdout");
    }
    // Close-on-exec, so a process an eval starts doesn't inherit them.
    libc.cloexec(inFd);
    libc.cloexec(outFd);
    final path = '/dev/null'.toNativeUtf8();
    final devNull = libc.open(path, 0);
    malloc.free(path);
    libc.dup2(devNull, 0);
    libc.dup2(2, 1);
    // reeval's end may be a pipe or a socket, which can't be reopened by path,
    // so the fds are read and written as they are.
    return MessageChannel._(
      _lines(_readFd(inFd)),
      (line) => libc.writeAll(outFd, utf8.encode('$line\n')),
    );
  }

  static Stream<String> _lines(Stream<List<int>> bytes) => bytes
      .transform(const Utf8Decoder(allowMalformed: true))
      .transform(const LineSplitter());
}

/// The bytes read from [fd] until its end, by an isolate of its own, since
/// each read blocks.
Stream<List<int>> _readFd(int fd) {
  final port = ReceivePort();
  final controller = StreamController<List<int>>(onCancel: port.close);
  port.listen((message) {
    if (message is Uint8List) {
      controller.add(message);
    } else {
      port.close();
      unawaited(controller.close());
    }
  });
  unawaited(
    Isolate.spawn(_readLoop, (fd, port.sendPort), debugName: 'reeval-messages'),
  );
  return controller.stream;
}

void _readLoop((int, SendPort) args) {
  final (fd, out) = args;
  final libc = _Libc();
  const size = 65536;
  final buffer = malloc<Uint8>(size);
  while (true) {
    final n = libc.read(fd, buffer, size);
    if (n < 0 && libc.interrupted) continue;
    if (n <= 0) break;
    out.send(Uint8List.fromList(buffer.asTypedList(n)));
  }
  malloc.free(buffer);
  out.send(null);
}

final class _Libc {
  _Libc() : _lib = DynamicLibrary.process();

  final DynamicLibrary _lib;

  late final dup = _lib
      .lookupFunction<Int32 Function(Int32), int Function(int)>('dup');
  late final dup2 = _lib
      .lookupFunction<Int32 Function(Int32, Int32), int Function(int, int)>(
        'dup2',
      );
  late final open = _lib
      .lookupFunction<
        Int32 Function(Pointer<Utf8>, Int32),
        int Function(Pointer<Utf8>, int)
      >('open');
  late final _fcntl = _lib
      .lookupFunction<
        Int32 Function(Int32, Int32, VarArgs<(Int32,)>),
        int Function(int, int, int)
      >('fcntl');
  late final read = _lib
      .lookupFunction<
        IntPtr Function(Int32, Pointer<Uint8>, IntPtr),
        int Function(int, Pointer<Uint8>, int)
      >('read');
  late final _write = _lib
      .lookupFunction<
        IntPtr Function(Int32, Pointer<Uint8>, IntPtr),
        int Function(int, Pointer<Uint8>, int)
      >('write');
  late final _errno = Platform.isMacOS
      ? _lib.lookupFunction<
          Pointer<Int32> Function(),
          Pointer<Int32> Function()
        >('__error')
      : _lib.lookupFunction<
          Pointer<Int32> Function(),
          Pointer<Int32> Function()
        >('__errno_location');

  static const _eintr = 4;

  bool get interrupted => _errno().value == _eintr;

  void cloexec(int fd) => _fcntl(fd, 2, 1); // F_SETFD, FD_CLOEXEC

  void writeAll(int fd, List<int> bytes) {
    final buffer = malloc<Uint8>(bytes.length);
    buffer.asTypedList(bytes.length).setAll(0, bytes);
    var written = 0;
    try {
      while (written < bytes.length) {
        final n = _write(fd, buffer + written, bytes.length - written);
        if (n < 0 && interrupted) continue;
        if (n < 0) throw const OSError("couldn't write to reeval");
        written += n;
      }
    } finally {
      malloc.free(buffer);
    }
  }
}
