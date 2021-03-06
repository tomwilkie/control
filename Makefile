dist/%.py: src/%.py
	@mkdir -p $(@D)
	ln -f $< $@

dist/%.yaml: src/%.yaml
	@mkdir -p $(@D)
	cp $< $@

clean:
	rm -rf dist

# rcswitch build instructions & other native code.

CXXFLAGS=-O2 -fPIC

dist/rcswitch_wrap.cxx: third_party/rcswitch-pi/RCSwitch.h third_party/rcswitch-pi/rcswitch.i
	@mkdir -p $(@D)
	swig -c++ -python -o $@ third_party/rcswitch-pi/rcswitch.i

dist/rcswitch_wrap.o: dist/rcswitch_wrap.cxx
	$(CXX) $(CXXFLAGS) -c $+ -o $@ -I/usr/include/python2.7 -Ithird_party/rcswitch-pi

dist/RCSwitch.o: third_party/rcswitch-pi/RCSwitch.cpp
	@mkdir -p $(@D)
	$(CXX) $(CXXFLAGS) -c $+ -o $@

dist/_rcswitch.so: dist/rcswitch_wrap.o dist/RCSwitch.o
	$(CXX) -shared $(LDFLAGS) $+ -o $@ -lwiringPi

dist/fswatch/fswatch: third_party/fswatch/fswatch.o
	@mkdir -p $(@D)
	gcc -framework CoreServices -o $@ $<

live: dist/fswatch/fswatch
	dist/fswatch/fswatch . 'make dist'

# third party python
define THIRD_PARTY_py_template
dist/third_party/%.py: third_party/py/$(1)/%.py
	@mkdir -p $$(@D)
	cp $$< $$@

dist/third_party/%.json: third_party/py/$(1)/%.json
	@mkdir -p $$(@D)
	cp $$< $$@

dist/third_party/%.pem: third_party/py/$(1)/%.pem
	@mkdir -p $$(@D)
	cp $$< $$@
endef

third_party_py := $(shell find third_party/py/* -maxdepth 0 -type d | sed 's,^[^/]*/[^/]*/,,' | tr "\\n" " ")
$(foreach dir,$(third_party_py),$(eval $(call THIRD_PARTY_py_template,$(dir))))

third_party_pyfiles := $(shell find third_party/py -name *.py -o -name *.json -o -name *.pem\
	| egrep -v "example|doc|setup|testsuite"		\
	| sed 's,^third_party/[^/]*/[^/]*/,,'				\
	| egrep -v "^__init__.py" | tr "\\n" " ")
third_party_pyfiles := $(patsubst %,dist/third_party/%,$(third_party_pyfiles))

# Static targets
dist/static/%: src/static/%
	@mkdir -p $(@D)
	ln -f $< $@

dist/static/js/jquery.js: third_party/static/jquery/jquery-2.1.1.js
	@mkdir -p $(@D)
	cp $< $@

dist/static/js/handlebars.js: third_party/static/handlebars/handlebars-v2.0.0.js
	@mkdir -p $(@D)
	cp $< $@

# final actual targets
py_files := $(patsubst src/%,dist/%,$(shell find src -name *.py))
static_files = $(patsubst src/static/%,dist/static/%,$(shell find src/static -type f))
static_files := $(static_files) $(patsubst %,dist/static/%,js/jquery.js js/handlebars.js)

define INCLUDE_STATIC_SUBDIR
static_files := $(static_files) $(patsubst $(1)/%,dist/static/$(2)/%,$(shell find $(1) -type f))
dist/static/$(2)/%: $(1)/%
	@mkdir -p $$(@D)
	cp $$< $$@
endef

define INCLUDE_STATIC_FILE
static_files := $(static_files) dist/static/$(2)/$(shell basename $(1))
dist/static/$(2)/$(shell basename $(1)): $(1)
	@mkdir -p $$(@D)
	cp $$< $$@
endef

$(eval $(call INCLUDE_STATIC_SUBDIR,third_party/static/bootstrap/dist/css,css))
$(eval $(call INCLUDE_STATIC_SUBDIR,third_party/static/bootstrap/dist/js,js))
$(eval $(call INCLUDE_STATIC_SUBDIR,third_party/static/bootstrap/dist/fonts,fonts))
$(eval $(call INCLUDE_STATIC_SUBDIR,third_party/static/glyphicons_pro/glyphicons/web/bootstrap_example/css,css))
$(eval $(call INCLUDE_STATIC_SUBDIR,third_party/static/glyphicons_pro/glyphicons/web/bootstrap_example/fonts,fonts))
$(eval $(call INCLUDE_STATIC_FILE,third_party/static/moment/moment.js,js))
$(eval $(call INCLUDE_STATIC_FILE,third_party/static/d3/d3.js,js))
$(eval $(call INCLUDE_STATIC_FILE,third_party/static/sprintf.js/src/sprintf.js,js))
$(eval $(call INCLUDE_STATIC_FILE,third_party/static/jquery-bbq/jquery.ba-bbq.js,js))
$(eval $(call INCLUDE_STATIC_FILE,third_party/static/pako/dist/pako_inflate.js,js))

dist/static: $(static_files)

dist: dist/app.yaml dist/cron.yaml $(py_files) $(third_party_pyfiles) dist/static

upload-prod: dist
	appcfg.py --oauth2 update dist

upload-dev: dist
	appcfg.py --oauth2 --application=awesomation-dev update dist

devapp: dist
	PYTHONPATH=${PYTHONPATH}:./dist:./dist/third_party dev_appserver.py --use_mtime_file_watcher=true --host=0.0.0.0 dist/app.yaml

pusher: dist
	PYTHONPATH=${PYTHONPATH}:./dist:./dist/third_party python dist/pi/simple_pusher.py

runpi: dist
	sudo PYTHONPATH=$${PYTHONPATH}:dist:dist/third_party python dist/pi/control.py --nodaemonize restart

runonpi: dist
	rsync -arvz dist/ pi@domicspi.local:~/dist/
	ssh -t pi@domicspi.local 'sudo PYTHONPATH=$${PYTHONPATH}:~/dist:~/dist/third_party python ~/dist/pi/control.py --nodaemonize restart'

APPENGINE=/Applications/GoogleAppEngineLauncher.app/Contents/Resources/GoogleAppEngine-default.bundle/Contents/Resources/google_appengine/

test: dist
	PYTHONPATH=$${PYTHONPATH}:dist:dist/third_party bin/appenginetest $(APPENGINE) dist

