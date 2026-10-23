import 'dart:io';

import 'package:reeval/src/launcher.dart';

Future<void> main(List<String> args) async {
  exitCode = await launch(args);
  await stderr.flush();
  exit(exitCode);
}
