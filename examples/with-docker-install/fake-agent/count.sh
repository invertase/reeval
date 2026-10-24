#!/usr/bin/env bash
jq '[.[] | select(.total > 100)] | length' orders.json
