// What an eval wrote at a call: `expect(result.exitCode, …)` is named by
// `result.exitCode`, read from the eval file at the caller's frame.
import 'dart:io';
import 'dart:isolate';

import 'package:stack_trace/stack_trace.dart';

/// A check's name is at most this long.
const subjectLimit = 200;

final _sources = <Uri, List<String>?>{};

List<String>? _lines(Uri uri) => _sources.putIfAbsent(uri, () {
  try {
    final resolved = uri.scheme == 'package'
        ? Isolate.resolvePackageUriSync(uri)
        : uri;
    if (resolved == null || resolved.scheme != 'file') return null;
    return File.fromUri(resolved).readAsLinesSync();
  } on Object {
    return null;
  }
});

/// The first frame of [trace] in the eval's own code, not reeval's or a
/// testing library's.
Frame? evalFrame(StackTrace trace) {
  for (final frame in Trace.from(trace).frames) {
    if (frame.isCore || frame.uri.scheme == 'data') continue;
    if (const {
      'reeval',
      'matcher',
      'checks',
      'test_api',
      'stack_trace',
    }.contains(frame.package)) {
      continue;
    }
    return frame;
  }
  return null;
}

/// A check's subject on one line, short enough to be its name.
String oneLine(String source) {
  final text = source.trim().split(RegExp(r'\s+')).join(' ');
  return text.length <= subjectLimit
      ? text
      : '${text.substring(0, subjectLimit - 1)}…';
}

/// The source of the first argument of the call at [frame], as written.
String? firstArgument(Frame? frame) {
  final text = _from(frame);
  if (text == null) return null;
  var i = 0;
  // Past the callee (`expect`, `c.check`, `expectLater<int>`) to its `(`.
  while (i < text.length && text[i] != '(') {
    if (text[i] == ';' || text[i] == '{') return null;
    i++;
  }
  if (i == text.length) return null;
  final end = _argumentEnd(text, i + 1);
  if (end == null) return null;
  final arg = text.substring(i + 1, end);
  return arg.trim().isEmpty ? null : oneLine(arg);
}

/// The statement at [frame], as written, for a check made by a library whose
/// calls reeval can't read (`check(x).equals(2)`).
String? statementAt(Frame? frame) {
  final line = frame?.line;
  if (frame == null || line == null) return null;
  final lines = _lines(frame.uri);
  if (lines == null || line > lines.length) return null;
  var text = lines[line - 1].trim();
  if (text.endsWith(';')) text = text.substring(0, text.length - 1);
  if (text.startsWith('await ')) text = text.substring(6);
  return text.isEmpty ? null : oneLine(text);
}

/// The file's text from [frame]'s position to its end (enough of it).
String? _from(Frame? frame) {
  final line = frame?.line, column = frame?.column;
  if (frame == null || line == null || column == null) return null;
  final lines = _lines(frame.uri);
  if (lines == null || line > lines.length) return null;
  final first = lines[line - 1];
  if (column - 1 > first.length) return null;
  return [first.substring(column - 1), ...lines.skip(line).take(40)].join('\n');
}

/// Where the argument starting at [start] ends: at a `,` or the call's `)`,
/// outside brackets, strings and comments.
int? _argumentEnd(String text, int start) {
  var depth = 0;
  var i = start;
  while (i < text.length) {
    final ch = text[i];
    if (ch == '/' && i + 1 < text.length && text[i + 1] == '/') {
      i = text.indexOf('\n', i);
      if (i < 0) return null;
      continue;
    }
    if (ch == '/' && i + 1 < text.length && text[i + 1] == '*') {
      i = text.indexOf('*/', i + 2);
      if (i < 0) return null;
      i += 2;
      continue;
    }
    if (ch == "'" || ch == '"') {
      final raw = i > 0 && text[i - 1] == 'r';
      final end = _stringEnd(text, i, raw);
      if (end == null) return null;
      i = end;
      continue;
    }
    if ('([{'.contains(ch)) depth++;
    if (')]}'.contains(ch)) {
      if (depth == 0) return ch == ')' ? i : null;
      depth--;
    }
    if (ch == ',' && depth == 0) return i;
    i++;
  }
  return null;
}

/// The index after the string literal that opens at [start].
int? _stringEnd(String text, int start, bool raw) {
  final quote = text[start];
  final triple =
      text.length >= start + 3 && text.substring(start, start + 3) == quote * 3;
  final close = triple ? quote * 3 : quote;
  var i = start + close.length;
  while (i < text.length) {
    if (!raw && text[i] == r'\') {
      i += 2;
      continue;
    }
    if (!raw && text[i] == r'$' && i + 1 < text.length && text[i + 1] == '{') {
      // An interpolation: skip to its matching brace.
      var depth = 0;
      i++;
      while (i < text.length) {
        if (text[i] == '{') depth++;
        if (text[i] == '}' && --depth == 0) break;
        i++;
      }
      i++;
      continue;
    }
    if (text.startsWith(close, i)) return i + close.length;
    if (!triple && text[i] == '\n') return null;
    i++;
  }
  return null;
}
