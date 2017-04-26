if (typeof window === 'undefined')
{
	var StringDecoder = require('string_decoder').StringDecoder;
	var TextDecoder = function () {
		return {
			decode: function (data) {
				return new StringDecoder('utf8').write(new Buffer(data));
			}
		};
	};
	var JSZip = require('./jszip.min.js');
}


(function(exports){

	exports.convert = function(buffer, finish_callback, progress_callback, depth_limit) {

		// Keeping the large data in one place, so it's easier to make sure nothing is leaked
		var data;
		var stack;
		var fl_names;
		var fn_names;

		var process_file = function()
		{
			var LF = 10;

			// If the chunk size is too small, performance suffers. Having one chunk per line (to eliminate the .split())
			// yields unbearable performance. It seems that the ArrayBuffer operations are not as optimized as the String
			// operations yet.
			var chunk_size = 1000000;

			var skip_summary;
			var chunk;
			var chunk_string;
			var cleaned_chunk_string;
			var lines;
			var lf_pos;
			var chunk_no;
			var offset;
			var deleted;
			var current_block;
			var reading;

			var skip_first_block;

			offset = 0;
			chunk_no = 0;
			deleted = 0;
			reading = false;
			skip_summary = 0;
			current_block = [];

			stack = [];
			fl_names = {};
			fn_names = {};
			skip_first_block = true;

			(function cont() {

				chunk_no++;

				// Search for first line break of next chunk
				lf_pos = data.indexOf(LF, chunk_no * chunk_size - deleted) + deleted;

				if (lf_pos == -1 + deleted)
					lf_pos = data.length + deleted;

				chunk = data.slice(offset - deleted, lf_pos - deleted);
				offset = lf_pos + 1;

				//noinspection JSUnresolvedFunction
				chunk_string = new TextDecoder('utf-8').decode(chunk);

				cleaned_chunk_string = chunk_string.split('\r').join(''); // http://jsperf.com/replace-all-vs-split-join
				lines = cleaned_chunk_string.split('\n');

				lines.forEach(function (line) {

					if (reading)
					{
						if (line != '' && !skip_summary)
						{
							current_block.push(line);
							if (line.substr(-6) == '{main}')
								skip_summary = 3;
						}
						else
						{
							if (skip_summary)
								skip_summary--;
							else
							{
								if (!skip_first_block)
									process_block(current_block);
								skip_first_block = false;

								current_block = [];
							}
						}
					}
					else
					{
						if (line.substr(0, 7) == 'events:')
							reading = true;
					}

				});

				if (chunk_no % 100 == 0 && data.length > offset - deleted)
				{
					data = data.slice(offset - deleted);
					deleted += offset - deleted;
				}

				progress_callback(Math.round(100 / (data.length + deleted) * offset));

				if (lf_pos < (data.length + deleted))
					setTimeout(cont, 0);
				else
				{
					chunk = undefined;
					chunk_string = undefined;
					cleaned_chunk_string = undefined;
					lines = undefined;
					data = undefined;
					process_stack();
				}
			})();
		};

		var process_block  = function(v)
		{
			var entry;
			var child;
			var i;

			var get_name = function(s, prefix_length, mapping) {

				s = s.substr(prefix_length);

				var closing_parens_pos = s.indexOf(')');
				if (s.substr(0, 1) == '(' && closing_parens_pos != -1)
				{
					var long_name = s.substr(closing_parens_pos + 2);
					if (long_name != '')
						mapping[s.substr(1, closing_parens_pos - 1)] = long_name
					return s.substr(0, closing_parens_pos + 1)
				}
				else
					return s
			};

			if (v.length)
			{
				entry = {};
				entry.fl = get_name(v[0], 3, fl_names);
				entry.fn = get_name(v[1], 3, fn_names);

				entry.self_us = v[2].split(' ')[1] / 1; // this used to be "/ 10" but apparently that is not necessary anymore

				if (v.length > 3) // this block describes a return
				{
					entry.children = [];

					// In certain Xdebug versions the lines starting with "cfl=" are missing, in this case the sub-blocks are 3
					// lines long and start with the "cfn=" line
					if (v[3].substr(0, 4) == 'cfn=')
					{
						for (i = (v.length-3) / 3 ; i > 0 ; i--)
						{
							child = stack.pop();

							if (child.fn != get_name(v[3 + (i-1)*3], 4, fn_names))
								console.log('Mismatch!');

							child.cum_us = v[5 + (i-1)*3].split(' ')[1] / 1; // this used to be "/ 10" but apparently that is not necessary anymore

							child.called_from_file = entry.fl;
							child.called_from_line = parseInt(v[5 + (i-1)*3].split(' ')[0]);

							entry.children.push(child);
						}
					}
					else
					{
						for (i = (v.length-3) / 4 ; i > 0 ; i--)
						{
							child = stack.pop();

							if (child.fl != get_name(v[3 + (i-1)*4], 4, fl_names) || child.fn != get_name(v[4 + (i-1)*4], 4, fn_names))
								console.log('Mismatch!');

							child.cum_us = v[6 + (i-1)*4].split(' ')[1] / 1; // this used to be "/ 10" but apparently that is not necessary anymore

							child.called_from_file = entry.fl;
							child.called_from_line = parseInt(v[6 + (i-1)*4].split(' ')[0]);

							entry.children.push(child);
						}
					}

					entry.children.reverse();
				}

				stack.push(entry);
			}
		};

		var process_stack = function() {
			var output;
			var root_us;
			var strange_file;

			var unmap_name = function(short_name, mapping)
			{
				if (short_name != null && short_name.substr(0, 1) == '(' && short_name.substr(-1) == ')' && mapping[short_name.substr(1, short_name.length-2)] != null)
					return mapping[short_name.substr(1, short_name.length-2)];
				else
					return short_name;
			};

			var write = function (node)
			{
				var output;

				output = {
					name: unmap_name(node.fn, fn_names),
					value: node.cum_us,
					tooltip: unmap_name(node.fn, fn_names) + '<br>' + (Math.round(node.cum_us) / 1000) + ' ms<br>Called from: ' + unmap_name(node.called_from_file, fl_names) + ':' + node.called_from_line + '<br>' + 'Defined in: ' + unmap_name(node.fl, fl_names)
				};

				if (node.children)
				{
					output.children = [];
					node.children.forEach(function (child)
					{
						output.children.push(write(child));
					});
				}

				return output;
			};

			root_us = 0;

			// With certain Xdebug versions I have encountered files that were missing the {main} entry. If we ignore that
			// fact the file is still somewhat parsable:
			strange_file = true;
			stack.forEach(function (v) {
				if (unmap_name(v.fn, fn_names) == '{main}')
					strange_file = false;
			});

			if (strange_file)
				alert('Your file is missing the {main} entry. I\'ll try to parse it anyway, but treat results with suspicion.');

			// The file provides no cumulated time for the top level, so we calculate them ourselves:
			stack.forEach(function (v) {

				var cum_us = 0;
				if (v.children) v.children.forEach(function (v) {
					cum_us += v.cum_us;
				});

				v.cum_us = cum_us + v.self_us;

				root_us += v.cum_us;

			});

			output = {name: '', value: root_us, tooltip: (Math.round(root_us) / 1000) + ' ms<br>All scripts and shutdown functions', children: []};

			stack.forEach(function (tle) {
				output.children.push(write(tle));
			});

			stack = undefined;

			// We don't need to show the root element if there is only one script
			if (output.children.length == 1)
				output = output.children[0];

			finish_callback(output);
		};

		var filename;

		data = new Uint8Array(buffer);

		//noinspection JSUnresolvedFunction
		if (new TextDecoder('utf8').decode(data.slice(0,2)) == 'PK')
		{
			//noinspection JSUnresolvedFunction
			var zip = new JSZip();
			zip.load(data);

			//noinspection LoopStatementThatDoesntLoopJS
			for (filename in zip.files) break;

			data = zip.file(filename).asUint8Array();
		}

		process_file();
	};


})(typeof exports === 'undefined'? this['converter']={}: exports);
