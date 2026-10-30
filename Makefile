.PHONY: test guard-tests native-check
test: guard-tests
	python3 -B automation/daily.py --test-only --root .

guard-tests:
	python3 -B -m unittest discover -s tests -v

native-check:
	npm run check
