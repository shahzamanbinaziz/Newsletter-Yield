#!/bin/sh
# The dashboard files here are copies of ../public. Run this after changing anything in ../public.
cd "$(dirname "$0")" && cp ../public/index.html ../public/app.js ../public/style.css . && echo "dashboard copied"
