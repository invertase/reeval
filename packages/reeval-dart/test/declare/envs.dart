import 'package:reeval/reeval.dart';

final base = Environment('base', env: {'MODE': 'base'});
final skilled = base.extend('skilled', env: {'MODE': 'skilled'});
final terse = base.extend('terse', env: {'MODE': 'terse'});
