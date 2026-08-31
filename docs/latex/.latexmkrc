# XeLaTeX writes XDV first; make its TeX Live PDF converter discoverable when
# the front-end commands are exposed through symlinks in a user-local bin dir.
my $tex_bin = `kpsewhich -var-value=SELFAUTOLOC`;
chomp $tex_bin;
my $converter = ($^O eq 'MSWin32')
    ? "$tex_bin/xdvipdfmx.exe"
    : "$tex_bin/xdvipdfmx";
if ($tex_bin ne '' && -x $converter) {
    my $path_sep = ($^O eq 'MSWin32') ? ';' : ':';
    my $path = $ENV{PATH} // '';
    my %path_entries = map { $_ => 1 } split /\Q$path_sep\E/, $path;
    $ENV{PATH} = "$tex_bin$path_sep$path"
        unless $path_entries{$tex_bin};
}
