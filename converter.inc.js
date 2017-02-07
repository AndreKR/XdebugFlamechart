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

		var LF = 10;

		var file_type;

		// Keeping the large data in one place, so it's easier to make sure nothing is leaked
		var data;
		var stack;

		var process_file = function()
		{
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

				if (file_type == 'profile')
				{
					lines.forEach(function (line) {

						if (reading)
						{
							if (line != '' && !skip_summary)
							{
								current_block.push(line);
								if (line == 'fn={main}')
									skip_summary = 3;
							}
							else
							{
								if (skip_summary)
									skip_summary--;
								else
								{
									if (!skip_first_block)
										process_profile_block(current_block);
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
				}
				if (file_type == 'trace')
				{
					lines.forEach(function (line) {
						if (reading)
						{
							process_trace_line(line);
						}
						else
						{
							if (line.substr(0, 11) == 'TRACE START')
								reading = true;
						}
					});
				}

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
					process_profile_stack();
				}
			})();
		};

		var process_trace_line = function (line) {
			var parts = line.split('\t');
			var is_return = !!parts[2];
			var time_index = parts[3];
			var function_name = parts[5] + parts[7];
			var called_from = parts[8] + ':' + parts[9];


		};

		var process_profile_block  = function(v)
		{
			var entry;
			var child;
			var i;

			if (v.length)
			{
				entry = {};
				entry.fl = v[0].substr(3);
				entry.fn = v[1].substr(3);

				entry.self_us = v[2].split(' ')[1] / 1; // this used to be "/ 10" but apparently that is not necessary anymore

				if (v.length > 3) // this block describes a return
				{
					entry.children = [];
					for (i = (v.length-3) / 4 ; i > 0 ; i--)
					{
						child = stack.pop();

						if (child.fl != v[3 + (i-1)*4].substr(4) || child.fn != v[4 + (i-1)*4].substr(4))
							console.log('Mismatch!');

						child.cum_us = v[6 + (i-1)*4].split(' ')[1] / 1; // this used to be "/ 10" but apparently that is not necessary anymore

						child.called_from_file = entry.fl;
						child.called_from_line = parseInt(v[6 + (i-1)*4].split(' ')[0]);

						entry.children.push(child);
					}
					entry.children.reverse();
				}

				stack.push(entry);
			}
		};

		var process_profile_stack = function() {
			var output;
			var root_us;

			var write = function (node)
			{
				var output;

				output = {
					name: node.fn,
					value: node.cum_us,
					tooltip: node.fn + '<br>' + (Math.round(node.cum_us) / 1000) + ' ms<br>Called from: ' + node.called_from_file + ':' + node.called_from_line + '<br>' + 'Defined in: ' + node.fl
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

			// The file provides no cumulated time for the top level, so we calculate them ourselves:
			stack.forEach(function (v) {

				var cum_us = 0;
				v.children.forEach(function (v) {
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
		var i;
		var idx = 0;

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

		// Find the beginning of the third line
		idx = data.indexOf(LF, idx+1);
		idx = data.indexOf(LF, idx+1);
		var third_line = new TextDecoder('utf8').decode(data.slice(idx+1, data.indexOf(LF, idx+1)));

		if (third_line.substr(0, 5) == 'TRACE')
		{
			file_type = 'trace';
			process_file();
		}
		else if (third_line.substr(0, 4) == 'cmd:')
		{
			file_type = 'profile';
			process_file();
		}
		else
		{
			alert('Unrecognized file type');
		}
	};


})(typeof exports === 'undefined'? this['converter']={}: exports);
